param([string]$AppRoot = (Split-Path -Parent $PSScriptRoot), [string]$GradleCache = (Join-Path $env:USERPROFILE '.gradle/caches/modules-2/files-2.1'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path -Parent $AppRoot
$source = $repo
$cache = $GradleCache
$model = [xml](Get-Content -LiteralPath "$repo\app\android\app\build\intermediates\lint_vital_report_lint_model\release\generateReleaseLintVitalReportModel\release-artifact-libraries.xml" -Raw)
$sections = [System.Collections.Generic.List[string]]::new()
$sections.Add("Native dependency notices for NAI Pocket $((Get-Content -LiteralPath (Join-Path $AppRoot 'package.json') -Raw | ConvertFrom-Json).version)`nGenerated from the resolved release dependency model and packaged Maven notices.`nApache-2.0 full terms are included separately in Apache-2.0.txt.`n")
foreach ($library in $model.libraries.library) {
  if (-not $library.resolved) { continue }
  $parts = $library.resolved.Split(':')
  $moduleDir = Join-Path $cache (Join-Path $parts[0] (Join-Path $parts[1] $parts[2]))
  $pomFile = Get-ChildItem -LiteralPath $moduleDir -Recurse -Filter '*.pom' | Select-Object -First 1
  if (-not $pomFile) { throw "Missing POM: $($library.resolved)" }
  $pom = [xml](Get-Content -LiteralPath $pomFile.FullName -Raw)
  $licenses = @($pom.project.licenses.license | ForEach-Object { "$($_.name) $($_.url)" })
  $sections.Add("=== $($library.resolved) ===`n$($licenses -join "`n")`n")
  foreach ($jar in @($library.jars -split ';')) {
    if (-not (Test-Path -LiteralPath $jar)) { continue }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($jar)
    try {
      foreach ($entry in $archive.Entries) {
        if ($entry.FullName -match '(?i)(^|/)(LICENSE|NOTICE|COPYING)([-.][^/]*)?$' -and $entry.Length -lt 500000) {
          $reader = [System.IO.StreamReader]::new($entry.Open())
          try { $sections.Add("-- $($entry.FullName) --`n$($reader.ReadToEnd())") } finally { $reader.Dispose() }
        }
      }
    } finally { $archive.Dispose() }
  }
}
[System.IO.File]::WriteAllText("$source\app\licenses\Native-dependencies.txt", ($sections -join "`n`n")+"`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Collected $($model.libraries.library.Count) resolved native libraries and packaged notices."
