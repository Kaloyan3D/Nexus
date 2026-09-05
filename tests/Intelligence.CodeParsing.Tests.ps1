[CmdletBinding()]param([string]$InstallRoot = 'C:\AI-Harness')
Set-StrictMode -Version Latest;$ErrorActionPreference = 'Stop'
. (Join-Path $InstallRoot 'scripts/Common.ps1')
. (Join-Path $InstallRoot 'scripts/Intelligence.ps1')

# ── Phase 3.2C/D: structural parsing + definitions/references semantics ─────
$passed = 0
$nl = [string][char]10
function Assert-Aih([bool]$Condition, [string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Host "PASS: $Name" }

# ── TypeScript structural parser ────────────────────────────────────────────
$tsContent = @(
    'import { AuthService, Token } from ''./auth'';',
    'import * as path from ''path'';',
    'import ''polyfill'';',
    'export interface UserRecord {',
    '  id: string;',
    '  name?: string;',
    '}',
    '',
    'export enum Role { Admin, User }',
    '',
    'export type Handler = (req: string) => void;',
    '',
    'export class AuthService extends Base {',
    '  private cache: Map<string, Token> = new Map();',
    '  constructor(private store: Token) {',
    '    super();',
    '  }',
    '  async login(user: string): Promise<boolean> {',
    '    const token = await this.store.fetch(user);',
    '    return token.isValid();',
    '  }',
    '  get ready(): boolean {',
    '    return true;',
    '  }',
    '}',
    '',
    'export function createService(config: any) {',
    '  return new AuthService(config);',
    '}',
    '',
    'export const defaultConfig = { retries: 3 };',
    'const helper = (x: number) => x * 2;'
) -join $nl
$tsId = 'cfi_tsprobe0000000000000000'
$ts = Invoke-AihStructuralTsJs -Content $tsContent -FileIntelligenceId $tsId
$names = @{}
foreach ($s in @($ts.symbols)) { $names[$s.kind + ':' + $s.name] = $s }
Assert-Aih ($names.ContainsKey('interface:UserRecord') -and $names['interface:UserRecord'].endLine -eq 7) 'TS interface parsed with brace-matched range'
Assert-Aih ($names.ContainsKey('enum:Role') -and $names.ContainsKey('typeAlias:Handler')) 'TS enum and type alias parsed'
Assert-Aih ($names.ContainsKey('class:AuthService')) 'TS class parsed'
Assert-Aih ($names.ContainsKey('method:login') -and $names['method:login'].container -eq 'AuthService') 'TS method nested under class container'
Assert-Aih ($names.ContainsKey('method:ready')) 'TS getter parsed as method'
Assert-Aih ($names.ContainsKey('function:createService') -and $names['function:createService'].exported) 'TS exported function parsed with export flag'
Assert-Aih ($names.ContainsKey('constant:defaultConfig')) 'TS const object parsed as constant'
Assert-Aih ($names.ContainsKey('function:helper')) 'TS arrow function parsed as function symbol'
Assert-Aih ($ts.imports.Count -ge 3 -and $ts.imports[0].bindings -contains 'AuthService') 'TS import bindings extracted from import clause'
Assert-Aih ($ts.imports[1].rawTarget -eq 'path') 'TS namespace import raw target recorded verbatim'
Assert-Aih ($ts.exports.Count -ge 5) 'TS export declarations collected'
$defs = @($ts.occurrences | Where-Object { $_.role -eq 'definition' -and $_.name -eq 'AuthService' })
Assert-Aih ($defs.Count -ge 1 -and $defs[0].resolution -eq 'exact') 'TS definitions carry exact resolution evidence'
$calls = @($ts.occurrences | Where-Object { $_.role -eq 'call' -and $_.name -eq 'AuthService' })
Assert-Aih ($calls.Count -ge 1 -and $calls[0].resolution -eq 'unresolved') 'TS bare-name calls recorded as unresolved (never fake-resolved)'
$dotCalls = @($ts.occurrences | Where-Object { $_.role -eq 'call' -and $_.name -eq 'fetch' })
Assert-Aih ($dotCalls.Count -eq 0) 'TS member calls are not claimed as bare-name calls (documented scope)'
$kwCalls = @($ts.occurrences | Where-Object { $_.role -eq 'call' -and $_.name -eq 'if' })
Assert-Aih ($kwCalls.Count -eq 0) 'TS keyword pseudo-calls excluded'

# ── reference policy: same-file unique vs ambiguous (conservative, F05) ────
$refContent = @(
    'import { uniqueHelper } from ''./external'';',
    'function uniqueHelper() {',
    '  return 1;',
    '}',
    '',
    'function duplicated() {',
    '  return 2;',
    '}',
    '',
    'function duplicated(also) {',
    '  return duplicated(also);',
    '}',
    '',
    '// uniqueHelper mentioned in a comment must not resolve',
    'const commentProbe = "uniqueHelper inside a string must not resolve";',
    '',
    'function shadowingProbe(uniqueHelper) {',
    '  return uniqueHelper;',
    '}',
    '',
    'export function caller() {',
    '  const a = uniqueHelper();',
    '  const b = duplicated(3);',
    '  const c = uniqueHelper;',
    '  return a + b + c;',
    '}'
) -join $nl
$ref = Invoke-AihStructuralTsJs -Content $refContent -FileIntelligenceId 'cfi_refprobe00000000000000'
$uniqueRefs = @($ref.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'uniqueHelper' })
Assert-Aih ($uniqueRefs.Count -eq 1 -and $uniqueRefs[0].resolution -eq 'same-file-unique' -and $uniqueRefs[0].line -eq 24) 'unique same-file name resolves only its identifier use (same-file-unique evidence)'
$callLineRefs = @($ref.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'uniqueHelper' -and $_.line -eq 22 })
Assert-Aih ($callLineRefs.Count -eq 0) 'call position of a unique same-file name is never double-counted as a resolved reference'
$callOcc = @($ref.occurrences | Where-Object { $_.role -eq 'call' -and $_.name -eq 'uniqueHelper' -and $_.line -eq 22 })
Assert-Aih ($callOcc.Count -eq 1 -and $callOcc[0].resolution -eq 'unresolved') 'same-file call keeps honest unresolved call evidence'
$commentOrStringOcc = @($ref.occurrences | Where-Object { ($_.role -eq 'reference' -or $_.role -eq 'call') -and $_.name -eq 'uniqueHelper' -and ($_.line -eq 14 -or $_.line -eq 15) })
Assert-Aih ($commentOrStringOcc.Count -eq 0) 'comments and string literals never yield call or reference evidence'
$importLineOcc = @($ref.occurrences | Where-Object { ($_.role -eq 'reference' -or $_.role -eq 'call') -and $_.name -eq 'uniqueHelper' -and $_.line -eq 1 })
Assert-Aih ($importLineOcc.Count -eq 0) 'import declaration lines never yield resolved references'
$shadowOcc = @($ref.occurrences | Where-Object { ($_.role -eq 'reference' -or $_.role -eq 'call') -and $_.name -eq 'uniqueHelper' -and ($_.line -eq 16 -or $_.line -eq 17) })
Assert-Aih ($shadowOcc.Count -eq 0) 'parameter-shadowed name never resolves to the outer same-file definition'
$ambigRefs = @($ref.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'duplicated' })
Assert-Aih ($ambigRefs.Count -eq 0) 'ambiguous same-file name yields NO invented resolution (negative ambiguity test)'

# ── C# structural parser ────────────────────────────────────────────────────
$csContent = @(
    'using System;',
    'using System.Collections.Generic;',
    '',
    'namespace Nexus.Core {',
    '  public interface IWorker {',
    '    void Run(int count);',
    '  }',
    '',
    '  public class WorkerService : IWorker {',
    '    private readonly int _retries;',
    '    public int Retries { get; private set; }',
    '    public WorkerService(int retries) {',
    '      _retries = retries;',
    '    }',
    '    public void Run(int count) {',
    '      Console.WriteLine(count);',
    '    }',
    '  }',
    '  internal enum State { Idle, Busy }',
    '}'
) -join $nl
$cs = Invoke-AihStructuralCSharp -Content $csContent -FileIntelligenceId 'cfi_csprobe0000000000000000'
$csNames = @{}
foreach ($s in @($cs.symbols)) { $csNames[$s.kind + ':' + $s.name] = $s }
Assert-Aih ($csNames.ContainsKey('namespace:Nexus.Core')) 'C# namespace parsed'
Assert-Aih ($csNames.ContainsKey('interface:IWorker')) 'C# interface parsed'
Assert-Aih ($csNames.ContainsKey('class:WorkerService')) 'C# class parsed'
Assert-Aih ($csNames.ContainsKey('method:Run') -and $csNames['method:Run'].container -eq 'Nexus.Core.WorkerService') 'C# method nested with dotted container'
Assert-Aih ($csNames.ContainsKey('property:Retries')) 'C# property parsed'
Assert-Aih ($csNames.ContainsKey('enum:State')) 'C# enum parsed'
Assert-Aih ($cs.imports.Count -eq 2 -and $cs.imports[0].rawTarget -eq 'System') 'C# usings recorded as raw imports'
Assert-Aih ($csNames['method:Run'].visibility -eq 'public') 'C# visibility evidence recorded'

# ── Python structural parser ────────────────────────────────────────────────
$pyLines = @(
    'import os',
    'from collections import OrderedDict as OD, defaultdict',
    '',
    'class AuthService:',
    '    """docstring"""',
    '    # fetch mentioned in a comment must not resolve',
    '    def __init__(self, store):',
    '        self.store = store',
    '',
    '    def login(self, user):',
    '        token = fetch(user)',
    '        return token',
    '',
    '    def fetch(self, user):',
    '        return None',
    '',
    'def standaloneHelper():',
    '    pass',
    '',
    'def helper():',
    '    return helper'
) -join $nl
$py = Invoke-AihStructuralPython -Content $pyLines -FileIntelligenceId 'cfi_pyprobe0000000000000000' -ModuleName 'auth'
$pyNames = @{}
foreach ($s in @($py.symbols)) { $pyNames[$s.kind + ':' + $s.name] = $s }
Assert-Aih ($pyNames.ContainsKey('module:auth')) 'Python module symbol always present'
Assert-Aih ($pyNames.ContainsKey('class:AuthService')) 'Python class parsed'
Assert-Aih ($pyNames.ContainsKey('method:login') -and $pyNames['method:login'].container -eq 'AuthService') 'Python method nested under class'
Assert-Aih ($pyNames.ContainsKey('method:fetch')) 'Python sibling method captured at same indent'
Assert-Aih ($pyNames.ContainsKey('function:helper')) 'Python top-level function parsed'
$fromImports = @($py.imports | Where-Object { $_.rawTarget -eq 'collections' })
Assert-Aih ($py.imports.Count -eq 2 -and $fromImports.Count -eq 1) 'Python from-imports recorded'
Assert-Aih (@($fromImports[0].bindings) -contains 'OD') 'Python alias binding uses the local alias'
$pyFetchRefs = @($py.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'fetch' })
Assert-Aih ($pyFetchRefs.Count -eq 0) 'Python call-position use of a unique method is never a resolved reference (conservative)'
$pyFetchCalls = @($py.occurrences | Where-Object { $_.role -eq 'call' -and $_.name -eq 'fetch' })
Assert-Aih ($pyFetchCalls.Count -eq 1 -and $pyFetchCalls[0].resolution -eq 'unresolved') 'Python call position keeps honest unresolved call evidence'
$pyHelperRefs = @($py.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'helper' })
Assert-Aih ($pyHelperRefs.Count -eq 1 -and $pyHelperRefs[0].resolution -eq 'same-file-unique') 'Python bare identifier use of a unique function resolves same-file-unique'
$pyCommentOcc = @($py.occurrences | Where-Object { ($_.role -eq 'reference' -or $_.role -eq 'call') -and $_.name -eq 'fetch' -and $_.line -eq 4 })
Assert-Aih ($pyCommentOcc.Count -eq 0) 'Python docstring/comment text never yields call or reference evidence'

# ── PowerShell structural parser ────────────────────────────────────────────
$ps1Content = @(
    'function Invoke-Deploy {',
    '    param([string]$Target)',
    '    Write-Output $Target',
    '}',
    '',
    '# Invoke-Deploy in a comment must not resolve',
    '$script:note = "Invoke-Deploy inside a string must not resolve"',
    '',
    'function Get-DeployStatus {',
    '    return Invoke-Deploy',
    '}'
) -join $nl
$ps1 = Invoke-AihStructuralPowerShell -Content $ps1Content -FileIntelligenceId 'cfi_psprobe0000000000000000'
Assert-Aih (@($ps1.symbols | Where-Object { $_.name -eq 'Invoke-Deploy' }).Count -eq 1) 'PowerShell function parsed'
Assert-Aih (@($ps1.symbols | Where-Object { $_.name -eq 'Get-DeployStatus' })[0].endLine -eq 11) 'PowerShell function range brace-matched'
$psRefs = @($ps1.occurrences | Where-Object { $_.role -eq 'reference' -and $_.name -eq 'Invoke-Deploy' })
Assert-Aih ($psRefs.Count -eq 1 -and $psRefs[0].resolution -eq 'same-file-unique' -and $psRefs[0].line -eq 10) 'PowerShell same-file function reference resolved from code only'
$psLexicalOcc = @($ps1.occurrences | Where-Object { ($_.role -eq 'reference' -or $_.role -eq 'call') -and $_.name -eq 'Invoke-Deploy' -and ($_.line -eq 6 -or $_.line -eq 7) })
Assert-Aih ($psLexicalOcc.Count -eq 0) 'PowerShell comments and strings never yield call or reference evidence'

# ── provider registry & capability matrix ───────────────────────────────────
$matrix = Get-AihProviderCapabilityMatrix
$tsRow = @($matrix | Where-Object { $_.providerId -eq 'structural-ts' })[0]
Assert-Aih ($tsRow.capabilities -contains 'references' -and $tsRow.version -eq '1.0.0') 'capability matrix exposes provider capabilities and version'
$providers = @(Get-AihCodeIntelligenceProviders)
Assert-Aih ($providers.Count -ge 4) 'provider registry ships four structural providers'

Write-Host ("Code parsing: $passed assertions passed.")
