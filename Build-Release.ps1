<#
.SYNOPSIS
    生成带版本号的单文件 EXE，并输出 .sha256 与 checksums.txt。

.DESCRIPTION
    需要 PowerShell 7+（pwsh）。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 中文读错，
    所以脚本开头会做一次版本检查，低于 7 直接退出并提示用 pwsh 运行。

    1. 校验 package.json 里的 version 与 -Version 一致
    2. 跑一次自测，不过就中止
    3. 调用 build.mjs 打包出 dist\netease-163key-tagger.exe
    4. 复制为 dist\netease-163key-tagger-v<版本>.exe
    5. 干跑一次 EXE 的 --cli，确认打包产物能正常启动
    6. 生成 .sha256 与 checksums.txt

.PARAMETER Version
    目标版本号，不带 v 前缀。默认读 package.json。

.PARAMETER SkipVerify
    跳过打包后的自检（不建议）。

.PARAMETER SkipTests
    跳过构建前的自测（不建议）。

.EXAMPLE
    pwsh .\Build-Release.ps1
    pwsh .\Build-Release.ps1 -Version 0.3.0
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipVerify,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

# ── 0. 必须是 PowerShell 7+ ───────────────────────────────────
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ''
    Write-Host "  当前是 Windows PowerShell $($PSVersionTable.PSVersion)，需要 PowerShell 7+。" -ForegroundColor Red
    Write-Host '  请改用： pwsh .\Build-Release.ps1' -ForegroundColor Yellow
    Write-Host '  （5.1 会把本脚本里的 UTF-8 中文读错，导致解析失败）'
    Write-Host ''
    exit 1
}
Write-Host "使用 PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$pkgPath = Join-Path $root 'package.json'

function Fail($msg) {
    Write-Host ''
    Write-Host $msg -ForegroundColor Red
    exit 1
}

# ── 1. 版本核对 ────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $pkgPath)) { Fail "找不到 package.json：$pkgPath" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pkgVersion = [string]$pkg.version
if (-not $Version) { $Version = $pkgVersion }

if ($pkgVersion -ne $Version) {
    Fail "package.json 里的版本是 '$pkgVersion'，与目标版本 '$Version' 不一致。请先同步版本号。"
}
Write-Host "版本 $Version 与 package.json 一致。" -ForegroundColor Green

# ── 2. 找 node ────────────────────────────────────────────────
$node = $null
foreach ($c in @((Get-Command node -ErrorAction SilentlyContinue).Source,
                 'C:\Program Files\nodejs\node.exe')) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
}
if (-not $node) { Fail '找不到 node，无法构建。请安装 Node.js 22 或更新版本。' }
$nodeVersion = & $node --version
Write-Host "使用 node $nodeVersion ($node)"
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "node 版本过低（$nodeVersion），需要 22 或更新。" }

# ── 3. 跑自测（构建前必须绿）─────────────────────────────────
if (-not $SkipTests) {
    Write-Host ''
    Write-Host '── 构建前自测 ──' -ForegroundColor Cyan
    & $node (Join-Path $root 'apply.mjs') 'self-test'
    if ($LASTEXITCODE -ne 0) { Fail '自测未通过，已中止构建。' }
    Write-Host '自测通过。' -ForegroundColor Green
}

# ── 4. 打包 ───────────────────────────────────────────────────
Write-Host ''
Write-Host '── 打包 EXE ──' -ForegroundColor Cyan
& $node (Join-Path $root 'build.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'build.mjs 失败。' }

$built = Join-Path $dist 'netease-163key-tagger.exe'
if (-not (Test-Path -LiteralPath $built)) { Fail "打包产物不存在：$built" }
$sizeMb = [math]::Round((Get-Item -LiteralPath $built).Length / 1MB, 1)
Write-Host "产物：$built ($sizeMb MB)" -ForegroundColor Green

# ── 5. 复制成带版本号的名字 ──────────────────────────────────
$versioned = Join-Path $dist "netease-163key-tagger-v$Version.exe"
Copy-Item -LiteralPath $built -Destination $versioned -Force
Write-Host "已生成带版本号的副本：$([IO.Path]::GetFileName($versioned))"

# ── 6. 冒烟测试 ───────────────────────────────────────────────
if (-not $SkipVerify) {
    Write-Host ''
    Write-Host '── 冒烟测试 ──' -ForegroundColor Cyan
    $out = & $versioned --cli 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $out -notmatch 'apply.mjs') {
        Write-Host $out
        Fail 'EXE 自检失败：--cli 没有输出预期用法信息。'
    }
    Write-Host 'EXE 能正常启动并响应 --cli。' -ForegroundColor Green
}

# ── 7. 生成校验文件 ──────────────────────────────────────────
Write-Host ''
Write-Host '── 生成校验文件 ──' -ForegroundColor Cyan
$artifacts = @($versioned)
foreach ($artifact in $artifacts) {
    $name = [IO.Path]::GetFileName($artifact)
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
    [IO.File]::WriteAllText("$artifact.sha256", "$hash  $name`r`n", [Text.Encoding]::ASCII)
    Write-Host "  $name.sha256  ->  $hash"
}

$checksums = Join-Path $dist 'checksums.txt'
$lines = foreach ($artifact in $artifacts) {
    $name = [IO.Path]::GetFileName($artifact)
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLower()
    "$hash  $name"
}
Set-Content -LiteralPath $checksums -Value $lines -Encoding ASCII
Write-Host "已刷新 checksums.txt（$($lines.Count) 项）。"

# ── 8. 汇总 ───────────────────────────────────────────────────
Write-Host ''
Write-Host '═══════════════════════════════════════' -ForegroundColor Cyan
Write-Host " 发布就绪：v$Version" -ForegroundColor Green
Write-Host '═══════════════════════════════════════' -ForegroundColor Cyan
Get-ChildItem -LiteralPath $dist -File | Sort-Object Name | ForEach-Object {
    $size = if ($_.Length -ge 1MB) { '{0:N1} MB' -f ($_.Length / 1MB) } else { '{0:N1} KB' -f ($_.Length / 1KB) }
    Write-Host ('  {0,-46} {1,10}' -f $_.Name, $size)
}
Write-Host ''
Write-Host '下一步（需要 GitHub CLI 已登录）：'
$exeName = "netease-163key-tagger-v$Version.exe"
$tag = "v$Version"
Write-Host ('  gh release create {0} "dist\{1}" dist\checksums.txt --title "{2}" --notes-file RELEASE-NOTES.md' -f $tag, $exeName, $tag)
