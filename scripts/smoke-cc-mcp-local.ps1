param([string]$CleanupDir)
$ErrorActionPreference='Stop'
if($CleanupDir){
  $full=(Resolve-Path -LiteralPath $CleanupDir).Path
  $temp=(Resolve-Path -LiteralPath $env:TEMP).Path
  if((Split-Path $full -Parent) -ne $temp -or (Split-Path $full -Leaf) -notmatch '^dsh-cc-local-smoke-[a-zA-Z0-9]+$'){throw 'Refuse non-fixture cleanup'}
  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
  Write-Output 'RESULT: CLEANUP_PASS'
  exit 0
}
# Directory removal stayed locked during the enclosing tool job on this host;
# the lock owner is unproven. Run -CleanupDir separately after it settles. Both stages
# must succeed before reporting the complete fixture as cleaned up.
$script=Join-Path $PSScriptRoot 'smoke-cc-mcp-local.mjs'
$lines=@(& node $script)
$code=$LASTEXITCODE
$lines | ForEach-Object { Write-Output $_ }
if($code -ne 0){exit $code}
if(-not ($lines -match '^PROTOCOL: PASS')){throw 'Missing protocol pass evidence'}
Write-Output 'RESULT: PROTOCOL_PASS (run separate cleanup stage using cleanupDir)'
