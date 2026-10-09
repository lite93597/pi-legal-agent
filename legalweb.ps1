[CmdletBinding()]
param(
	[string]$CaseDir,
	[ValidateRange(1024, 65535)][int]$Port = 18005,
	[string]$BaseUrl,
	[string]$Model,
	[switch]$AllowWrite,
	[switch]$Help
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repoDir 'scripts\legal-launch.mjs'
$launchArgs = @($launcher, 'web')
if ($Help) { $launchArgs += '--help' }
if ($PSBoundParameters.ContainsKey('CaseDir')) { $launchArgs += @('--case-dir', $CaseDir) }
if ($PSBoundParameters.ContainsKey('Port')) { $launchArgs += @('--port', [string]$Port) }
if ($PSBoundParameters.ContainsKey('BaseUrl')) { $launchArgs += @('--base-url', $BaseUrl) }
if ($PSBoundParameters.ContainsKey('Model')) { $launchArgs += @('--model', $Model) }
if ($AllowWrite) { $launchArgs += '--allow-write' }

& node @launchArgs
if ($LASTEXITCODE -ne 0) { throw "LegalAgent web exited with code $LASTEXITCODE" }
