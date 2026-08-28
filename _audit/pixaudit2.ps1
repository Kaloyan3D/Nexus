
$src = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

public static class PixAudit
{
    public static string Analyze(string path)
    {
        byte[] png = File.ReadAllBytes(path);
        // Parse PNG chunks
        int pos = 8;
        int width = 0, height = 0, bitDepth = 0, colorType = 0;
        MemoryStream idat = new MemoryStream();
        while (pos + 8 <= png.Length)
        {
            int len = (png[pos] << 24) | (png[pos + 1] << 16) | (png[pos + 2] << 8) | png[pos + 3];
            string type = Encoding.ASCII.GetString(png, pos + 4, 4);
            if (type == "IHDR")
            {
                width = (png[pos + 8] << 24) | (png[pos + 9] << 16) | (png[pos + 10] << 8) | png[pos + 11];
                height = (png[pos + 12] << 24) | (png[pos + 13] << 16) | (png[pos + 14] << 8) | png[pos + 15];
                bitDepth = png[pos + 16]; colorType = png[pos + 17];
            }
            else if (type == "IDAT") idat.Write(png, pos + 8, len);
            else if (type == "IEND") break;
            pos += 12 + len;
        }
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("PNG: " + width + "x" + height + " bitDepth=" + bitDepth + " colorType=" + colorType);
        int channels = colorType == 6 ? 4 : colorType == 2 ? 3 : colorType == 0 ? 1 : -1;
        if (channels < 0 || bitDepth != 8) return "UNSUPPORTED PNG FORMAT depth=" + bitDepth + " type=" + colorType;

        byte[] raw = idat.ToArray();
        // skip zlib header
        int zoff = 0;
        if (raw.Length > 2 && raw[0] == 0x78) zoff = 2;
        byte[] inflated;
        using (MemoryStream ms = new MemoryStream(raw, zoff, raw.Length - zoff))
        using (DeflateStream ds = new DeflateStream(ms, CompressionMode.Decompress))
        using (MemoryStream outMs = new MemoryStream())
        {
            ds.CopyTo(outMs);
            inflated = outMs.ToArray();
        }

        int stride = width * channels;
        byte[] img = new byte[height * stride];
        int src = 0;
        for (int y = 0; y < height; y++)
        {
            int filter = inflated[src++];
            int rowStart = y * stride;
            for (int x = 0; x < stride; x++)
            {
                int rawv = inflated[src++];
                int a = x >= channels ? img[rowStart + x - channels] : 0;
                int b = y > 0 ? img[rowStart - stride + x] : 0;
                int c = (x >= channels && y > 0) ? img[rowStart - stride + x - channels] : 0;
                int v;
                switch (filter)
                {
                    case 0: v = rawv; break;
                    case 1: v = rawv + a; break;
                    case 2: v = rawv + b; break;
                    case 3: v = rawv + (a + b) / 2; break;
                    default: v = rawv + Paeth(a, b, c); break;
                }
                img[rowStart + x] = (byte)(v & 0xFF);
            }
        }
        int w = width, h = height;
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
        int[] rowBorder = new int[h], colBorder = new int[w];

        for (int y = 0; y < h; y++)
        {
            int row = y * stride;
            int ry = y / 12;
            for (int x = 0; x < w; x++)
            {
                int i = row + x * channels;
                int b = img[i + 2], g = img[i + 1], r = img[i];
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
                if (d39 <= 18) { rowBorder[y]++; colBorder[x]++; }
            }
        }

        sb.AppendLine("COUNTS: violet=" + violetCount + " violetTL=" + violetTL + " blue=" + blueCount + " teal=" + tealCount + " bright=" + brightCount + " mid=" + midCount);
        sb.AppendLine("BG: main(#09090B~)=" + bgMain + " sidebar(#0D0D10~)=" + bgSide + " surface(#111116~)=" + sfc1 + " surface2(#17171D~)=" + sfc2 + " border(#27272F~)=" + brd);
        sb.AppendLine("VIOLET BBOX: x[" + vMinX + ".." + vMaxX + "] y[" + vMinY + ".." + vMaxY + "]");
        sb.AppendLine("BLUE BBOX: x[" + bMinX + ".." + bMaxX + "] y[" + bMinY + ".." + bMaxY + "]");
        sb.AppendLine("BRIGHT BBOX: x[" + wMinX + ".." + wMaxX + "] y[" + wMinY + ".." + wMaxY + "]");

        sb.AppendLine("TOP HIST:");
        List<int> keys = new List<int>(hist.Keys);
        keys.Sort(delegate (int a, int b2) { return hist[b2][0].CompareTo(hist[a][0]); });
        for (int k = 0; k < keys.Count && k < 30; k++)
        {
            long[] e = hist[keys[k]];
            sb.AppendLine(string.Format("  {0,7} px ({1,5:0.00}%) avg #{2:X2}{3:X2}{4:X2}", e[0], 100.0 * e[0] / total, e[1] / e[0], e[2] / e[0], e[3] / e[0]));
        }

        sb.AppendLine("COL PROFILE (avg per 8px band):");
        StringBuilder line = new StringBuilder();
        for (int x = 0; x < nc; x++) line.Append(colN[x] == 0 ? " ------ " : string.Format("#{0:X2}{1:X2}{2:X2}", colR[x] / colN[x], colG[x] / colN[x], colB[x] / colN[x]) + " ");
        sb.AppendLine(line.ToString());
        line = new StringBuilder();
        for (int x = 0; x < nc; x++) line.Append(x % 16 == 0 ? (x * 8).ToString().PadLeft(8) : "        ");
        sb.AppendLine("BAND X0 (8px units): " + line.ToString());

        sb.AppendLine("ROW PROFILE (avg per 12px band):");
        line = new StringBuilder();
        for (int y = 0; y < nr; y++) line.Append(rowN[y] == 0 ? " ----- " : string.Format("#{0:X2}{1:X2}{2:X2}", rowR[y] / rowN[y], rowG[y] / rowN[y], rowB[y] / rowN[y]) + " ");
        sb.AppendLine(line.ToString());

        sb.AppendLine("HORIZONTAL BORDER-LIKE ROWS (y:count of #27272F-ish px):");
        List<string> hb = new List<string>();
        for (int y = 0; y < h; y++) if (rowBorder[y] >= 800) hb.Add(y + ":" + rowBorder[y]);
        sb.AppendLine(hb.Count == 0 ? "  none" : "  " + string.Join(", ", hb.ToArray()));

        sb.AppendLine("VERTICAL BORDER-LIKE COLS (x:count of #27272F-ish px):");
        List<string> vb = new List<string>();
        for (int x = 0; x < w; x++) if (colBorder[x] >= 500) vb.Add(x + ":" + colBorder[x]);
        sb.AppendLine(vb.Count == 0 ? "  none" : "  " + string.Join(", ", vb.ToArray()));

        sb.AppendLine("BRIGHT+MID DENSITY MAP (24px cells; ' '=0 '.'=1-4 ':'=5-19 'o'=20-79 '#'=80+):");
        sb.AppendLine("     " + string.Join("", ColHeader(cw)));
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
        sb.AppendLine("     " + string.Join("", ColHeader(cw)));
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
        sb.AppendLine("     " + string.Join("", ColHeader(cw)));
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

        int fcell = 8, fw = (360 + fcell - 1) / fcell, fh = (140 + fcell - 1) / fcell;
        int[] fv = new int[fw * fh], fb = new int[fw * fh];
        for (int y = 0; y < 140 && y < h; y++)
            for (int x = 0; x < 360 && x < w; x++)
            {
                int i = y * stride + x * channels;
                int b = img[i + 2], g = img[i + 1], r = img[i];
                int lum = (r * 299 + g * 587 + b * 114) / 1000;
                int cxi = x / fcell, cyi = y / fcell;
                if (b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) fv[cyi * fw + cxi]++;
                if (lum >= 150) fb[cyi * fw + cxi]++;
            }
        sb.AppendLine("TOP-LEFT FINE VIOLET MAP (8px cells x0-360 y0-140; '.'=1-3 '*'=4-15 '#'=16+):");
        sb.AppendLine("     " + string.Join("", ColHeader(fw)));
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
        sb.AppendLine("TOP-LEFT FINE LIGHT MAP (8px cells lum>=150; '.'=1-2 '*'=3-8 '#'=9+):");
        sb.AppendLine("     " + string.Join("", ColHeader(fw)));
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
        return sb.ToString();
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    private static IEnumerable<char> ColHeader(int n)
    {
        for (int i = 0; i < n; i++)
        {
            string s = (i * 24).ToString();
            yield return s.Length > 0 ? s[0] : ' ';
        }
    }
}
'@
Add-Type -TypeDefinition $src
[PixAudit]::Analyze('C:\AI-Harness\_nexus_shot1.png')
