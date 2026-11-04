# Benchmark: Build a Production-Grade Job Scheduler From Scratch

You are starting in a completely empty directory.

Your task is to design, implement, test, and deliver a production-quality persistent, dependency-aware job scheduler from zero.

You have full responsibility for architecture, project initialization, implementation, debugging, testing, and verification.

Do not ask for guidance. Make reasonable engineering decisions independently.

## Technology requirements

- Language: Rust (stable)
- Database: SQLite
- Interface: CLI
- Build system: Cargo
- Testing: Rust's standard testing framework and appropriate integration tests
- You may choose additional libraries when justified.

Initialize the entire project yourself.

## Core requirements

### 1. Job management
Implement:
- Unique job identifiers
- Job creation, listing, inspection, and cancellation
- Configurable job priorities
- Dependencies between jobs
- Configurable timeouts
- Retry policies with exponential backoff
- Job execution history

### 2. Execution engine
Implement:
- Concurrent job execution
- Configurable maximum worker count
- Dependency-aware scheduling
- Priority-based selection of ready jobs
- Safe cancellation of running jobs
- Correct state transitions

### 3. Persistence and recovery
Implement:
- SQLite-backed persistence
- Recovery after unexpected termination
- Safe handling of interrupted jobs
- Transactional state updates
- Protection against duplicate execution where possible
- Explicit documentation of execution guarantees

### 4. Failure handling
Implement:
- Circular dependency detection
- Dependency failure propagation
- Timeout enforcement
- Worker crash handling
- Database failure handling
- Graceful shutdown

### 5. CLI
Provide commands to:
- Register a job
- List jobs
- Inspect job status
- Start the scheduler
- Cancel a job
- View execution history
- Display scheduler statistics

### 6. Documentation
Create a README explaining:
- Architecture
- Installation
- CLI usage
- Job lifecycle
- Recovery behavior
- Known limitations

## Mandatory tests

Implement and execute automated tests for:

1. Normal job execution
2. Dependency ordering
3. Circular dependency rejection
4. Priority scheduling
5. Worker concurrency limits
6. Retry behavior
7. Timeout enforcement
8. Job cancellation
9. Persistence after restart
10. Recovery after forced process termination
11. Simultaneous job completion
12. Worker failures
13. Dependency failure propagation
14. Database error handling

At least one integration test must forcibly terminate the scheduler while jobs are running, restart it, and verify recovery behavior.

## Engineering rules

- Begin by planning the architecture.
- Create the project and implement it.
- Run actual builds and tests.
- Investigate failures and fix their underlying causes.
- Never alter tests simply to hide implementation defects.
- Do not claim tests passed without executing them.
- Do not replace implementation with pseudocode.
- Do not stop after the first successful compilation.
- Do not leave essential functionality as TODOs or placeholders.
- Continue working until the requirements are satisfied or you encounter a genuine blocker.

## Definition of done

The project must compile, provide a functional CLI, persist and execute jobs correctly, recover safely from interruptions, and pass meaningful automated tests.

Before declaring completion, perform a final independent verification pass using the available tools.

## Final report

Provide:

1. Architecture overview
2. Implemented functionality
3. Project structure
4. Tests executed and actual results
5. Bugs discovered and fixed
6. Remaining defects or limitations
7. Commands for reproducing the verification

Clearly distinguish implemented, tested, partially implemented, and unimplemented functionality.

Your goal is to deliver working software, not merely a convincing report.

Begin now.