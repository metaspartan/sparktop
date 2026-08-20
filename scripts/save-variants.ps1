<#
.SYNOPSIS
    Capture the eight DGX Spark chassis images from the clipboard.

.DESCRIPTION
    Walks through each variant in turn. For each one: copy the image (right-click
    an image in a browser or chat and choose "Copy image"), then press Enter.
    The clipboard bitmap is written to a staging folder as PNG.

    Afterwards, turn the captures into transparent WebP icons:

        python scripts/split-variants.py --singles .\.variant-staging

    Run from the repository root:

        powershell -ExecutionPolicy Bypass -File scripts/save-variants.ps1

.NOTES
    Press S to skip a variant, or Q to stop early. Re-running only re-captures
    the ones you choose; existing files are left alone unless overwritten.
#>

[CmdletBinding()]
param(
    [string]$OutDir = ".variant-staging"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Order matches the variant ids the web UI looks for.
$variants = [ordered]@{
    nvidia   = "NVIDIA DGX Spark (Founders Edition) - the gold one"
    asus     = "ASUS Ascent GX10 - silver, vertical ridges, power button"
    dell     = "Dell Pro Max with GB10 - dark honeycomb grille"
    hp       = "HP ZGX Nano AI Station - diamond lattice"
    lenovo   = "Lenovo ThinkStation PGX - hexagonal mesh"
    msi      = "MSI EdgeXpert - brushed slats"
    gigabyte = "GIGABYTE AI TOP ATOM - wave pattern"
    acer     = "Acer Veriton GN100 - vertical fins with a bright bar"
}

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

Write-Host ""
Write-Host "Capturing DGX Spark variant images to $OutDir" -ForegroundColor Green
Write-Host "For each variant: copy the image, then press Enter. S skips, Q quits." -ForegroundColor DarkGray
Write-Host ""

$captured = 0
foreach ($id in $variants.Keys) {
    $dest = Join-Path $OutDir "$id.png"
    $answer = Read-Host "  [$id] $($variants[$id])`n  Copy it, then press Enter"

    if ($answer -eq 'q') { break }
    if ($answer -eq 's') {
        Write-Host "    skipped" -ForegroundColor DarkGray
        continue
    }

    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
        Write-Host "    No image on the clipboard - skipping $id" -ForegroundColor Yellow
        continue
    }

    $img = [System.Windows.Forms.Clipboard]::GetImage()
    try {
        $img.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host "    saved $($img.Width)x$($img.Height) -> $dest" -ForegroundColor Green
        $captured++
    } finally {
        $img.Dispose()
    }
}

Write-Host ""
Write-Host "Captured $captured image(s)." -ForegroundColor Green
if ($captured -gt 0) {
    Write-Host "Now convert them to transparent WebP icons:" -ForegroundColor Cyan
    Write-Host "    python scripts/split-variants.py --singles $OutDir" -ForegroundColor White
    Write-Host "    bun run build:web" -ForegroundColor White
}
