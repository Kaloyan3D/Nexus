// nexus-vm: the headless Linux microVM runner for Nexus.app (Apple Virtualization.framework).
//
//   nexus-vm daemon --state-dir DIR     boot the VM described by DIR/vm.json, serve DIR/vm.sock
//   nexus-vm attach --state-dir DIR     connect stdin/stdout to the engine bridge in the guest
//                                       (starts the daemon first when it is not running)
//   nexus-vm stop   --state-dir DIR     ask the daemon to shut the VM down
//
// The guest is reached ONLY over virtio-vsock: nothing listens on the Mac's network, and the Unix
// socket is private to the user (0700 directory). The daemon owns the VM; `attach` is what the
// app's bridge transport spawns, exactly like it used to spawn ssh.
import CryptoKit
import Darwin
import Foundation
import Virtualization

struct Config: Codable {
    var kernel: String
    /// Pristine system image. When `rootfsRun` is set, each boot runs a fresh copy-on-write clone of it, so nothing
    /// the guest writes to its system disk survives (user data lives on `stateDisk`).
    var rootfs: String
    var rootfsRun: String? = nil
    var stateDisk: String?
    var cpus: Int = 4
    var memoryMB: Int = 2048
    var vsockPort: UInt32 = 1024
    var cmdline: String = "console=hvc0 root=/dev/vda rw rootfstype=ext4 quiet"
    var idleSeconds: Int = 120
}

func now() -> Double { Date().timeIntervalSince1970 }
func say(_ s: String) { FileHandle.standardError.write(Data("nexus-vm: \(s)\n".utf8)) }
func die(_ s: String, _ code: Int32 = 1) -> Never { say(s); exit(code) }

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

guard let stateArg = arg("--state-dir") else { die("--state-dir is required", 64) }
let stateDir = URL(fileURLWithPath: stateArg)
// Unix socket paths are limited to ~100 bytes, and application-support paths can be long: the socket lives in
// the per-user temporary directory under a name derived from the state directory (0600, owner-checked).
let sockPath: String = {
    let h = SHA256.hash(data: Data(stateDir.standardizedFileURL.path.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
    let p = NSTemporaryDirectory() + "nexus-vm-\(h).sock"
    if p.utf8.count > 100 { die("the engine socket path is too long: \(p)", 73) }
    return p
}()

func sockaddr(_ path: String) -> (sockaddr_un, socklen_t) {
    var a = sockaddr_un()
    a.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &a.sun_path) { p in
        for (i, b) in bytes.enumerated() where i < p.count - 1 { p[i] = b }
    }
    return (a, socklen_t(MemoryLayout<sockaddr_un>.size))
}

/// Copy `from` to `to` until EOF/error, then half-close.
func pump(_ from: Int32, _ to: Int32, done: @escaping () -> Void) {
    Thread.detachNewThread {
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(from, &buf, buf.count)
            if n <= 0 { break }
            var off = 0
            while off < n {
                let w = buf.withUnsafeBytes { write(to, $0.baseAddress! + off, n - off) }
                if w <= 0 { done(); return }
                off += w
            }
        }
        done()
    }
}

// ---------------------------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------------------------
func connectDaemon() -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var (a, len) = sockaddr(sockPath)
    let ok = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: Darwin.sockaddr.self, capacity: 1) { connect(fd, $0, len) } }
    if ok == 0 { return fd }
    close(fd)
    return nil
}

func runAttach() -> Never {
    var fd = connectDaemon()
    if fd == nil {
        // start the daemon (detached) and wait for its socket
        let p = Process()
        p.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        p.arguments = ["daemon", "--state-dir", stateDir.path]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle(forWritingAtPath: stateDir.appendingPathComponent("daemon.log").path)
            ?? { FileManager.default.createFile(atPath: stateDir.appendingPathComponent("daemon.log").path, contents: nil)
                 return FileHandle(forWritingAtPath: stateDir.appendingPathComponent("daemon.log").path)! }()
        do { try p.run() } catch { die("cannot start the engine VM: \(error)") }
        let t0 = now()
        while now() - t0 < 30 {
            if let f = connectDaemon() { fd = f; break }
            usleep(50_000)
        }
    }
    guard let sock = fd else { die("the engine VM did not start") }
    var finished = false
    let lock = NSLock()
    let finish = {
        lock.lock(); defer { lock.unlock() }
        if !finished { finished = true; exit(0) }
    }
    pump(0, sock, done: { shutdown(sock, SHUT_WR); finish() })
    pump(sock, 1, done: finish)
    dispatchMain()
}

func runStop() -> Never {
    if let s = try? String(contentsOf: stateDir.appendingPathComponent("daemon.pid"), encoding: .utf8), let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
        kill(pid, SIGTERM)
    }
    exit(0)
}

// ---------------------------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------------------------
final class Engine: NSObject, VZVirtualMachineDelegate {
    let cfg: Config
    var vm: VZVirtualMachine!
    var ready = false
    var lastClient = now()
    var clients = 0
    let started = now()

    init(_ c: Config) { cfg = c }

    func build() throws -> VZVirtualMachineConfiguration {
        let c = VZVirtualMachineConfiguration()
        let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: cfg.kernel))
        boot.commandLine = cfg.cmdline
        c.bootLoader = boot
        c.cpuCount = max(1, min(cfg.cpus, ProcessInfo.processInfo.processorCount))
        c.memorySize = UInt64(cfg.memoryMB) << 20
        c.platform = VZGenericPlatformConfiguration()
        var rootPath = cfg.rootfs
        if let run = cfg.rootfsRun {
            unlink(run)
            if copyfile(cfg.rootfs, run, nil, copyfile_flags_t(COPYFILE_ALL | COPYFILE_CLONE)) != 0 { throw NSError(domain: "nexus-vm", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "cannot clone the system image"]) }
            rootPath = run
        }
        var disks: [VZStorageDeviceConfiguration] = [
            VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: rootPath), readOnly: false)),
        ]
        if let s = cfg.stateDisk {
            disks.append(VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: s), readOnly: false)))
        }
        c.storageDevices = disks
        let net = VZVirtioNetworkDeviceConfiguration()
        net.attachment = VZNATNetworkDeviceAttachment()
        c.networkDevices = [net]
        c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        c.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        let log = stateDir.appendingPathComponent("console.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        // Development aid: a FIFO named console.in in the state directory becomes the guest's console input.
        let fifo = stateDir.appendingPathComponent("console.in").path
        var input: FileHandle? = nil
        var st = stat()
        if stat(fifo, &st) == 0, (st.st_mode & S_IFMT) == S_IFIFO {
            let fd = open(fifo, O_RDWR)
            if fd >= 0 { input = FileHandle(fileDescriptor: fd, closeOnDealloc: true) }
        }
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: input, fileHandleForWriting: FileHandle(forWritingAtPath: log.path))
        c.serialPorts = [serial]
        try c.validate()
        return c
    }

    func start() {
        do { vm = VZVirtualMachine(configuration: try build()) } catch { die("invalid VM configuration: \(error)") }
        vm.delegate = self
        vm.start { r in
            switch r {
            case .success: say("vm started in \(String(format: "%.2f", now() - self.started))s"); self.ready = true
            case .failure(let e): die("the VM did not start: \(e)")
            }
        }
    }

    func guestDidStop(_ vm: VZVirtualMachine) { say("guest stopped"); cleanup(); exit(0) }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { say("vm error: \(error)"); cleanup(); exit(2) }

    func cleanup() {
        try? FileManager.default.removeItem(atPath: sockPath)
        try? FileManager.default.removeItem(at: stateDir.appendingPathComponent("daemon.pid"))
    }

    func stop() {
        say("stopping")
        DispatchQueue.main.async {
            if self.vm.canRequestStop { try? self.vm.requestStop() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                self.vm.stop { _ in self.cleanup(); exit(0) }
            }
        }
    }

    /// Bridge one client to a fresh vsock connection, waiting for the guest to come up.
    func serve(client: Int32) {
        clients += 1
        DispatchQueue.main.async { self.connectGuest(client, tries: 0) }
    }

    func connectGuest(_ client: Int32, tries: Int) {
        guard let dev = vm.socketDevices.first as? VZVirtioSocketDevice, ready else {
            return retry(client, tries)
        }
        dev.connect(toPort: cfg.vsockPort) { r in
            switch r {
            case .success(let conn):
                let gfd = conn.fileDescriptor
                var closed = false
                let lock = NSLock()
                let end = {
                    lock.lock(); defer { lock.unlock() }
                    if closed { return }
                    closed = true
                    close(client); conn.close()
                    self.clients -= 1; self.lastClient = now()
                }
                pump(client, gfd, done: end)
                pump(gfd, client, done: end)
            case .failure:
                self.retry(client, tries)
            }
        }
    }

    func retry(_ client: Int32, _ tries: Int) {
        if tries > 600 { close(client); clients -= 1; return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.connectGuest(client, tries: tries + 1) }
    }
}

func runDaemon() -> Never {
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("vm.json")),
          let cfg = try? JSONDecoder().decode(Config.self, from: data) else { die("DIR/vm.json is missing or invalid", 66) }
    // one daemon per state directory
    let lockFd = open(stateDir.appendingPathComponent("lock").path, O_CREAT | O_RDWR, 0o600)
    if flock(lockFd, LOCK_EX | LOCK_NB) != 0 { die("a daemon is already running", 75) }
    try? "\(getpid())".write(to: stateDir.appendingPathComponent("daemon.pid"), atomically: true, encoding: .utf8)
    unlink(sockPath)
    let ls = socket(AF_UNIX, SOCK_STREAM, 0)
    var (a, len) = sockaddr(sockPath)
    let bound = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: Darwin.sockaddr.self, capacity: 1) { bind(ls, $0, len) } }
    if bound != 0 { die("cannot create the engine socket") }
    chmod(sockPath, 0o600)
    listen(ls, 8)

    let engine = Engine(cfg)
    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    term.setEventHandler { engine.stop() }
    term.resume()
    DispatchQueue.main.async { engine.start() }
    Thread.detachNewThread {
        while true {
            let c = accept(ls, nil, nil)
            if c < 0 { continue }
            // only the owning user may talk to the engine
            var uid: uid_t = 0, gid: gid_t = 0
            if getpeereid(c, &uid, &gid) != 0 || uid != getuid() { close(c); continue }
            engine.serve(client: c)
        }
    }
    // idle shutdown: nobody attached for `idleSeconds`
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 30, repeating: 30)
    timer.setEventHandler {
        if engine.clients == 0 && now() - engine.lastClient > Double(cfg.idleSeconds) { engine.stop() }
    }
    timer.resume()
    dispatchMain()
}

switch CommandLine.arguments.dropFirst().first {
case "daemon": runDaemon()
case "attach": runAttach()
case "stop": runStop()
default: die("usage: nexus-vm daemon|attach|stop --state-dir DIR", 64)
}
