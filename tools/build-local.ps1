# Offline APK build: no Android SDK, no Gradle, no AGP.
# Uses the build-tools already on disk (aapt2/d8/apksigner/zipalign) plus android.jar.
# Everything this project needs: plain Java sources, 6 resource XMLs, an assets tree.
#
#   pwsh -File tools/build-local.ps1
#
# Output: dist/dsh-mobile.apk (release-signed with keystore.jks, same key as CI).
#
# Two toolchain notes learned the hard way:
#   * build-tools 34's d8 (R8 8.2.2) cannot parse class files produced by JDK 25 and
#     dies with "NullPointerException: String.length()" on any inner class, so this
#     script uses build-tools 36.1's d8.jar through `java -cp`.
#   * AGP injects the manifest package attribute from the gradle namespace; raw aapt2
#     needs it in the file, so a patched copy is written to build/manual/.
$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$BuildTools = Join-Path $Root 'tools\buildtools\android-14'
$AndroidJar = Join-Path $Root 'tools\platform\android-34-ext12\android.jar'
$Work       = Join-Path $Root 'build\manual'
$Out        = Join-Path $Root 'dist\dsh-mobile.apk'

foreach ($p in @($BuildTools, $AndroidJar)) {
    if (-not (Test-Path $p)) { throw "missing: $p" }
}

if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Work, (Join-Path $Work 'gen'), (Join-Path $Work 'classes'), (Join-Path $Work 'dex'), (Join-Path $Root 'dist') | Out-Null

$manifest = Join-Path $Root 'app\src\main\AndroidManifest.xml'
$resDir   = Join-Path $Root 'app\src\main\res'
$assetsDir= Join-Path $Root 'app\src\main\assets'
$javaDir  = Join-Path $Root 'app\src\main\java'

# version values are read from the gradle file so the APK always matches the repo
$gradle = Get-Content (Join-Path $Root 'app\build.gradle.kts') -Raw
$versionCode = ([regex]::Match($gradle, 'versionCode\s*=\s*(\d+)')).Groups[1].Value
$versionName = ([regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $versionCode -or -not $versionName) { throw 'could not read versionCode/versionName' }
Write-Host "building $versionName ($versionCode)"

# 1) compile resources
Write-Host '[1/5] aapt2 compile'
$resZip = Join-Path $Work 'res.zip'
& (Join-Path $BuildTools 'aapt2.exe') compile --dir $resDir -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed ($LASTEXITCODE)" }

# AGP injects the package attribute from the gradle namespace; raw aapt2 needs it in the manifest.
$pkg = ([regex]::Match($gradle, 'namespace\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $pkg) { throw 'could not read namespace' }
$linkManifest = Join-Path $Work 'AndroidManifest.xml'
((Get-Content $manifest -Raw) -replace '<manifest\s', ('<manifest package="' + $pkg + '" ')) | Set-Content -Path $linkManifest -Encoding utf8

# 2) link resources + assets into an unsigned apk and emit R.java
Write-Host '[2/5] aapt2 link'
$baseApk = Join-Path $Work 'base.apk'
& (Join-Path $BuildTools 'aapt2.exe') link `
    -o $baseApk `
    -I $AndroidJar `
    --manifest $linkManifest `
    -A $assetsDir `
    --java (Join-Path $Work 'gen') `
    --min-sdk-version 26 --target-sdk-version 34 `
    --version-code $versionCode --version-name $versionName `
    --auto-add-overlay `
    $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed ($LASTEXITCODE)" }

# aapt2 on Windows writes asset entry names with backslashes; normalise them before signing.
Write-Host '[2b/5] normalise zip entry names'
$fixedApk = Join-Path $Work 'fixed.apk'
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'fix-zip-names.ps1') -In $baseApk -Out $fixedApk
if ($LASTEXITCODE -ne 0) { throw "zip normalise failed ($LASTEXITCODE)" }

# 3) compile java (sources + generated R.java)
Write-Host '[3/5] javac'
$sources = @()
$sources += Get-ChildItem (Join-Path $javaDir '') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem (Join-Path $Work 'gen') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
if (-not $sources.Count) { throw 'no java sources found' }
$argFile = Join-Path $Work 'javac.args'
$esc = $sources | ForEach-Object { '"' + ($_ -replace '\\', '\\') + '"' }
Set-Content -Path $argFile -Value $esc -Encoding ascii
& javac -source 17 -target 17 -nowarn -classpath $AndroidJar -d (Join-Path $Work 'classes') "@$argFile" 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { throw "javac failed ($LASTEXITCODE)" }

# 4) dex
Write-Host '[4/5] d8'
$classes = Get-ChildItem (Join-Path $Work 'classes') -Recurse -Filter *.class | ForEach-Object { $_.FullName }
if (-not $classes.Count) { throw 'no class files produced' }
$d8Args = Join-Path $Work 'd8.args'
Set-Content -Path $d8Args -Value ($classes | ForEach-Object { $_.Replace('\\', '\\') }) -Encoding ascii
$D8Jar = Join-Path $Root 'tools\platform\android-16\lib\d8.jar'
if (-not (Test-Path $D8Jar)) { throw "missing newer d8: $D8Jar" }
& java -cp $D8Jar com.android.tools.r8.D8 --release --min-api 26 --lib $AndroidJar --output (Join-Path $Work 'dex') "@$d8Args"
if ($LASTEXITCODE -ne 0) { throw "d8 failed ($LASTEXITCODE)" }
$dex = Join-Path $Work 'dex\classes.dex'
if (-not (Test-Path $dex)) { throw 'classes.dex was not produced' }

# 5) pack dex into the apk, align, sign
Write-Host '[5/5] package + align + sign'
Copy-Item $dex (Join-Path $Work 'classes.dex') -Force
& jar uf $fixedApk -C $Work classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar uf failed ($LASTEXITCODE)" }

$aligned = Join-Path $Work 'aligned.apk'
& (Join-Path $BuildTools 'zipalign.exe') -f 4 $fixedApk $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed ($LASTEXITCODE)" }

$keystore = Join-Path $Root 'keystore.jks'
if (Test-Path $Out) { Remove-Item $Out -Force }
& (Join-Path $BuildTools 'apksigner.bat') sign `
    --ks $keystore --ks-pass pass:dshmobile --ks-key-alias dshm --key-pass pass:dshmobile `
    --v1-signing-enabled true --v2-signing-enabled true `
    --out $Out $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner failed ($LASTEXITCODE)" }

& (Join-Path $BuildTools 'apksigner.bat') verify --print-certs $Out | Select-Object -First 3

$item = Get-Item $Out
$hash = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host "built:  $($item.FullName)"
Write-Host "size:   $($item.Length) bytes"
Write-Host "sha256: $hash"
Write-Host "version:$versionName ($versionCode)"

