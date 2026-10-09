[CmdletBinding()]
param(
	[string]$CaseDir,
	[string]$BaseUrl,
	[string]$Model,
	[string]$Prompt,
	[switch]$AllowWrite,
	[switch]$NoSaveSession,
	[switch]$Help
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repoDir 'scripts\legal-launch.mjs'
$launchArgs = @($launcher, 'cli')
if ($Help) { $launchArgs += '--help' }
if ($PSBoundParameters.ContainsKey('CaseDir')) { $launchArgs += @('--case-dir', $CaseDir) }
if ($PSBoundParameters.ContainsKey('BaseUrl')) { $launchArgs += @('--base-url', $BaseUrl) }
if ($PSBoundParameters.ContainsKey('Model')) { $launchArgs += @('--model', $Model) }
if ($PSBoundParameters.ContainsKey('Prompt')) { $launchArgs += @('--prompt', $Prompt) }
if ($AllowWrite) { $launchArgs += '--allow-write' }
if ($NoSaveSession) { $launchArgs += '--no-save-session' }

& node @launchArgs
if ($LASTEXITCODE -ne 0) { throw "LegalAgent CLI exited with code $LASTEXITCODE" }
