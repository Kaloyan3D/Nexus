
Add-Type -AssemblyName System.Drawing
$src = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class PixAudit
{
    public static string Analyze(string path)
    {
        StringBuilder sb = new StringBuilder();
        using (Bitmap bmp = new Bitmap(path))
        {
            int w = bmp.Width, h = bmp.Height;
            sb.AppendLine("SIZE: " + w + "x" + h);
            Rectangle rect = new Rectangle(0, 0, w, h);
            BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] by = new byte[stride * h];
            Marshal.Copy(data.Scan0, by, 0, by.Length);
            bmp.UnlockBits(data);
            long total = (long)w * h;

            Dictionary<int, long[]> hist = new Dictionary<int, long[]>();
            int nc = (w + 7) / 8; long[] colR = new long[nc], colG = new long[nc], colB = new long[nc]; int[] colN = new int[nc];
            int nr = (h + 11) / 12; long[] rowR = new long[nr], rowG = new long[nr], rowB = new long[nr]; int[] rowN = new int[nr];

            long violetCount = 0, violetTL = 0, blueCount = 0, tealCount = 0, brightCount = 0, midCount = 0;
            int vMinX = int.MaxValue, vMinY = int.MaxValue, vMaxX = -1, vMaxY = -1;
            int bMinX = int.MaxValue, bMinY = int.MaxValue, bMaxX = -1, bMaxY = -1;
            int wMinX = int.MaxValue, wMinY = int.MaxValue, wMaxX = -1, wMaxY = -1;
            long sfc1 = 0, sfc2 = 0, brd = 0, bgMain = 0, bgSide = 0;

            int cell = 24, cw = (w + 23) / 24, ch = (h + 23) / 24;
            int[] brightCell = new int[cw * ch], midCell = new int[cw * ch], violetCell = new int[cw * ch], blueCell = new int[cw * ch];

            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                int ry = y / 12;
                for (int x = 0; x < w; x++)
                {
                    int i = row + x * 4;
                    int b = by[i], g = by[i + 1], r = by[i + 2];
                    int lum = (r * 299 + g * 587 + b * 114) / 1000;
                    int key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                    long[] e;
                    if (!hist.TryGetValue(key, out e)) { e = new long[4]; hist[key] = e; }
                    e[0]++; e[1] += r; e[2] += g; e[3] += b;
                    int cx = x / 8, cxi = x / cell, cyi = y / cell;
                    colR[cx] += r; colG[cx] += g; colB[cx] += b; colN[cx]++;
                    rowR[ry] += r; rowG[ry] += g; rowB[ry] += b; rowN[ry]++;
                    if (lum >= 195) { brightCount++; brightCell[cyi * cw + cxi]++; if (x < wMinX) wMinX = x; if (x > wMaxX) wMaxX = x; if (y < wMinY) wMinY = y; if (y > wMaxY) wMaxY = y; }
                    else if (lum >= 120) { midCount++; midCell[cyi * cw + cxi]++; }
                    bool violet = b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215;
                    if (violet) { violetCount++; violetCell[cyi * cw + cxi]++; if (x < vMinX) vMinX = x; if (x > vMaxX) vMaxX = x; if (y < vMinY) vMinY = y; if (y > vMaxY) vMaxY = y; if (x < 360 && y < 130) violetTL++; }
                    bool blue = !violet && b >= 130 && (b - r) >= 45 && (b - g) >= 20;
                    if (blue) { blueCount++; blueCell[cyi * cw + cxi]++; if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y; }
                    bool teal = !violet && g >= 110 && b >= 110 && g >= r + 25;
                    if (teal) tealCount++;
                    int d17 = Math.Abs(r - 17) + Math.Abs(g - 17) + Math.Abs(b - 22);
                    int d23 = Math.Abs(r - 23) + Math.Abs(g - 23) + Math.Abs(b - 29);
                    int d39 = Math.Abs(r - 39) + Math.Abs(g - 39) + Math.Abs(b - 47);
                    int d9 = Math.Abs(r - 9) + Math.Abs(g - 9) + Math.Abs(b - 11);
                    int d13 = Math.Abs(r - 13) + Math.Abs(g - 13) + Math.Abs(b - 16);
                    if (d17 <= 24) sfc1++; if (d23 <= 24) sfc2++; if (d39 <= 30) brd++; if (d9 <= 12) bgMain++; if (d13 <= 12) bgSide++;
                }
            }

            sb.AppendLine("COUNTS: violet=" + violetCount + " violetTL=" + violetTL + " blue=" + blueCount + " teal=" + tealCount + " bright=" + brightCount + " mid=" + midCount);
            sb.AppendLine("BG: main(#09090B~)=" + bgMain + " sidebar(#0D0D10~)=" + bgSide + " surface(#111116~)=" + sfc1 + " surface2(#17171D~)=" + sfc2 + " border(#27272F~)=" + brd);
            sb.AppendLine("VIOLET BBOX: x[" + vMinX + ".." + vMaxX + "] y[" + vMinY + ".." + vMaxY + "]");
            sb.AppendLine("BLUE BBOX: x[" + bMinX + ".." + bMaxX + "] y[" + bMinY + ".." + bMaxY + "]");
            sb.AppendLine("BRIGHT BBOX: x[" + wMinX + ".." + wMaxX + "] y[" + wMinY + ".." + wMaxY + "]");

            sb.AppendLine("TOP HIST (key r,g,b avg | count | pct):");
            List<int> keys = new List<int>(hist.Keys);
            keys.Sort(delegate (int a, int b2) { return hist[b2][0].CompareTo(hist[a][0]); });
            for (int k = 0; k < keys.Count && k < 30; k++)
            {
                long[] e = hist[keys[k]];
                sb.AppendLine(string.Format("  {0,6} px ({1,5:0.00}%) avg #{2:X2}{3:X2}{4:X2}",
                    e[0], 100.0 * e[0] / total, e[1] / e[0], e[2] / e[0], e[3] / e[0]));
            }

            sb.AppendLine("COL PROFILE (avg per 8px band, hex):");
            StringBuilder line = new StringBuilder();
            for (int x = 0; x < nc; x++)
            {
                if (colN[x] == 0) { line.Append(" ------ "); continue; }
                line.Append(string.Format("#{0:X2}{1:X2}{2:X2}", colR[x] / colN[x], colG[x] / colN[x], colB[x] / colN[x])).Append(' ');
            }
            sb.AppendLine(line.ToString());
            sb.AppendLine("COL BAND X0 MARKERS (every 16 bands = 128px):");
            line = new StringBuilder();
            for (int x = 0; x < nc; x++) line.Append((x % 16 == 0 ? (x * 8).ToString().PadLeft(8) : "        "));
            sb.AppendLine(line.ToString());

            sb.AppendLine("ROW PROFILE (avg per 12px band, hex):");
            line = new StringBuilder();
            for (int y = 0; y < nr; y++)
            {
                if (rowN[y] == 0) { line.Append(" ----- "); continue; }
                line.Append(string.Format("#{0:X2}{1:X2}{2:X2}", rowR[y] / rowN[y], rowG[y] / rowN[y], rowB[y] / rowN[y])).Append(' ');
            }
            sb.AppendLine(line.ToString());

            sb.AppendLine("BRIGHT+MID DENSITY MAP (24px cells; ' '=0 '.'=1-4 ':'=5-19 'o'=20-79 '#'=80+):");
            sb.AppendLine("     " + string.Join("", EnumerateCols(cw)));
            for (int yy = 0; yy < ch; yy++)
            {
                StringBuilder m = new StringBuilder();
                m.Append((yy * 24).ToString().PadLeft(4)).Append(" |");
                for (int xx = 0; xx < cw; xx++)
                {
                    int v = brightCell[yy * cw + xx] + midCell[yy * cw + xx];
                    m.Append(v >= 80 ? '#' : v >= 20 ? 'o' : v >= 5 ? ':' : v >= 1 ? '.' : ' ');
                }
                sb.AppendLine(m.ToString());
            }

            sb.AppendLine("VIOLET MAP (24px cells; ' '=0 '.'=1-9 '*'=10-49 '#'=50+):");
            sb.AppendLine("     " + string.Join("", EnumerateCols(cw)));
            for (int yy = 0; yy < ch; yy++)
            {
                StringBuilder m = new StringBuilder();
                m.Append((yy * 24).ToString().PadLeft(4)).Append(" |");
                for (int xx = 0; xx < cw; xx++)
                {
                    int v = violetCell[yy * cw + xx];
                    m.Append(v >= 50 ? '#' : v >= 10 ? '*' : v >= 1 ? '.' : ' ');
                }
                sb.AppendLine(m.ToString());
            }

            sb.AppendLine("BLUE MAP (24px cells; ' '=0 '.'=1-9 '*'=10-49 '#'=50+):");
            sb.AppendLine("     " + string.Join("", EnumerateCols(cw)));
            for (int yy = 0; yy < ch; yy++)
            {
                StringBuilder m = new StringBuilder();
                m.Append((yy * 24).ToString().PadLeft(4)).Append(" |");
                for (int xx = 0; xx < cw; xx++)
                {
                    int v = blueCell[yy * cw + xx];
                    m.Append(v >= 50 ? '#' : v >= 10 ? '*' : v >= 1 ? '.' : ' ');
                }
                sb.AppendLine(m.ToString());
            }

            // Fine maps for top-left identity region
            int fcell = 8, fw = (360 + fcell - 1) / fcell, fh = (140 + fcell - 1) / fcell;
            int[] fv = new int[fw * fh], fb = new int[fw * fh];
            for (int y = 0; y < 140 && y < h; y++)
                for (int x = 0; x < 360 && x < w; x++)
                {
                    int i = y * stride + x * 4;
                    int b = by[i], g = by[i + 1], r = by[i + 2];
                    int lum = (r * 299 + g * 587 + b * 114) / 1000;
                    int cxi = x / fcell, cyi = y / fcell;
                    if (b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) fv[cyi * fw + cxi]++;
                    if (lum >= 150) fb[cyi * fw + cxi]++;
                }
            sb.AppendLine("TOP-LEFT FINE VIOLET MAP (8px cells, x0-360 y0-140; '.'=1-3 '*'=4-15 '#'=16+):");
            sb.AppendLine("     " + string.Join("", EnumerateCols(fw)));
            for (int yy = 0; yy < fh; yy++)
            {
                StringBuilder m = new StringBuilder();
                m.Append((yy * 8).ToString().PadLeft(4)).Append(" |");
                for (int xx = 0; xx < fw; xx++)
                {
                    int v = fv[yy * fw + xx];
                    m.Append(v >= 16 ? '#' : v >= 4 ? '*' : v >= 1 ? '.' : ' ');
                }
                sb.AppendLine(m.ToString());
            }
            sb.AppendLine("TOP-LEFT FINE BRIGHT/LIGHT MAP (8px cells, lum>=150; '.'=1-2 '*'=3-8 '#'=9+):");
            sb.AppendLine("     " + string.Join("", EnumerateCols(fw)));
            for (int yy = 0; yy < fh; yy++)
            {
                StringBuilder m = new StringBuilder();
                m.Append((yy * 8).ToString().PadLeft(4)).Append(" |");
                for (int xx = 0; xx < fw; xx++)
                {
                    int v = fb[yy * fw + xx];
                    m.Append(v >= 9 ? '#' : v >= 3 ? '*' : v >= 1 ? '.' : ' ');
                }
                sb.AppendLine(m.ToString());
            }
        }
        return sb.ToString();
    }

    private static IEnumerable<char> EnumerateCols(int n)
    {
        for (int i = 0; i < n; i++)
        {
            int x = i * 24;
            string s = x.ToString();
            yield return s.Length > 0 ? s[0] : ' ';
        }
    }
}
'@
Add-Type -TypeDefinition $src
[PixAudit]::Analyze('C:AI-Harness_nexus_shot1.png')
