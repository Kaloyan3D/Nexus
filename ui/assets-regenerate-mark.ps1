$ErrorActionPreference = 'Stop'
# Regenerates ui/nexus-ui/assets/nexus-mark.png from the official lockup asset.
# The mark is the leftmost content cluster of nexus-logo.png (detected bounding
# box x 108-384, y 486-768 at 1254px), centered on a 288x288 transparent canvas.
Add-Type -AssemblyName System.Drawing
$srcPath = Join-Path $PSScriptRoot 'nexus-ui/assets/nexus-logo.png'
$outPath = Join-Path $PSScriptRoot 'nexus-ui/assets/nexus-mark.png'
$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$crop = New-Object System.Drawing.Bitmap 276, 282
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 276, 282), (New-Object System.Drawing.Rectangle 108, 486, 276, 282), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$out = New-Object System.Drawing.Bitmap 288, 288
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.DrawImage($crop, 6, 3, 276, 282)
$g2.Dispose()
$crop.Dispose()
$out.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
$src.Dispose()
Write-Host 'nexus-mark.png regenerated'