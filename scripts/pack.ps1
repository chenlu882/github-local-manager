$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
$output = [System.IO.Path]::GetFullPath((Join-Path $source '..\发布文件'))
New-Item -ItemType Directory -Path $output -Force | Out-Null
$stage = Join-Path $output ('staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$runtime = Join-Path $stage 'runtime\github-local-manager'
$sources = Join-Path $stage 'source\github-local-manager'
New-Item -ItemType Directory -Path $runtime,$sources -Force | Out-Null
$runtimeFiles = @('dist','web','skills','docs','plugin.json','mcp.json','README.md','LICENSE','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.txt','启动管理器.cmd','接入Codex.cmd')
foreach($name in $runtimeFiles) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $runtime $name) -Recurse -Force }
$sourceFiles = $runtimeFiles + @('core','test','scripts','.github','.gitignore','package.json','package-lock.json','manager.js','paths.js','panel.js','panel-control.js','server.js','launcher.js','build.mjs')
foreach($name in $sourceFiles) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $sources $name) -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach($kind in @('runtime','source')) {
  $suffix = if($kind -eq 'runtime'){'windows'}else{'source'}
  $archive = Join-Path $output "github-local-manager-$version-$suffix.zip"
  if(Test-Path -LiteralPath $archive) { throw "Archive exists: $archive" }
  [System.IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $stage $kind),$archive)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entries = @($zip.Entries | ForEach-Object FullName)
    if($entries | Where-Object { $_ -match '(^|/)(node_modules|data|backups|\.test-output)(/|$)|panel-session|settings\.json$' }) { throw 'Runtime/private files found in archive' }
    foreach($required in @('plugin.json','mcp.json','dist/server.js','dist/launcher.js','web/index.html','skills/github-local-manager/SKILL.md')) {
      if($entries -notcontains "github-local-manager/$required") { throw "Missing $required" }
    }
    foreach($entry in $zip.Entries | Where-Object { $_.FullName -match '(\.js|\.json|\.md|\.cmd)$' }) {
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try { $text = $reader.ReadToEnd(); if($text -match 'Users[\\/]+[^\\/\s]+[\\/]|codex-clipboard-|ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}') {throw "Personal data found: $($entry.FullName)"} } finally { $reader.Dispose() }
    }
    Write-Output "$suffix package verified: $($entries.Count) files"
  } finally { $zip.Dispose() }
  Get-FileHash -LiteralPath $archive -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $([System.IO.Path]::GetFileName($_.Path))" } | Set-Content -LiteralPath "$archive.sha256.txt" -Encoding utf8
  Write-Output $archive
}
