
$src = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

public static class PixAudit3
{
    private static int[] crcTable;
    static PixAudit3()
    {
        crcTable = new int[256];
        for (int n = 0; n < 256; n++)
        {
            int c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? unchecked((int)0xEDB88320 ^ (c >> 1)) : (c >> 1);
            crcTable[n] = c;
        }
    }
    private static uint Crc32(byte[] buf, int off, int len)
    {
        uint c = 0xFFFFFFFF;
        for (int i = off; i < off + len; i++) c = (uint)crcTable[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFF;
    }
    private static void WriteChunk(Stream s, string type, byte[] data)
    {
        byte[] lenB = new byte[] { (byte)(data.Length >> 24), (byte)(data.Length >> 16), (byte)(data.Length >> 8), (byte)data.Length };
        s.Write(lenB, 0, 4);
        byte[] t = Encoding.ASCII.GetBytes(type);
        s.Write(t, 0, 4);
        s.Write(data, 0, data.Length);
        byte[] crcInput = new byte[4 + data.Length];
        Buffer.BlockCopy(t, 0, crcInput, 0, 4);
        Buffer.BlockCopy(data, 0, crcInput, 4, data.Length);
        uint crc = Crc32(crcInput, 0, crcInput.Length);
        s.WriteByte((byte)(crc >> 24)); s.WriteByte((byte)(crc >> 16)); s.WriteByte((byte)(crc >> 8)); s.WriteByte((byte)crc);
    }
    public static void SavePng(string path, int w, int h, byte[] rgba)
    {
        using (FileStream fs = File.Create(path))
        {
            fs.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
            byte[] ihdr = new byte[13];
            ihdr[0] = (byte)(w >> 24); ihdr[1] = (byte)(w >> 16); ihdr[2] = (byte)(w >> 8); ihdr[3] = (byte)w;
            ihdr[4] = (byte)(h >> 24); ihdr[5] = (byte)(h >> 16); ihdr[6] = (byte)(h >> 8); ihdr[7] = (byte)h;
            ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
            WriteChunk(fs, "IHDR", ihdr);
            byte[] raw = new byte[(w * 4 + 1) * h];
            int p = 0;
            for (int y = 0; y < h; y++)
            {
                raw[p++] = 0;
                Buffer.BlockCopy(rgba, y * w * 4, raw, p, w * 4);
                p += w * 4;
            }
            byte[] deflated;
            using (MemoryStream ms = new MemoryStream())
            {
                using (DeflateStream ds = new DeflateStream(ms, CompressionLevel.Optimal, true)) ds.Write(raw, 0, raw.Length);
                deflated = ms.ToArray();
            }
            byte[] idat = new byte[2 + deflated.Length + 4];
            idat[0] = 0x78; idat[1] = 0x9C;
            Buffer.BlockCopy(deflated, 0, idat, 2, deflated.Length);
            uint adler = Adler32(raw);
            idat[idat.Length - 4] = (byte)(adler >> 24); idat[idat.Length - 3] = (byte)(adler >> 16);
            idat[idat.Length - 2] = (byte)(adler >> 8); idat[idat.Length - 1] = (byte)adler;
            WriteChunk(fs, "IDAT", idat);
            WriteChunk(fs, "IEND", new byte[0]);
        }
    }
    private static uint Adler32(byte[] buf)
    {
        uint a = 1, b = 0;
        for (int i = 0; i < buf.Length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
        return (b << 16) | a;
    }

    private static byte[] Decode(string path, out int w, out int h)
    {
        byte[] png = File.ReadAllBytes(path);
        int pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
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
        int channels = colorType == 6 ? 4 : colorType == 2 ? 3 : colorType == 0 ? 1 : -1;
        byte[] raw = idat.ToArray();
        int zoff = raw.Length > 2 && raw[0] == 0x78 ? 2 : 0;
        byte[] inflated;
        using (MemoryStream ms = new MemoryStream(raw, zoff, raw.Length - zoff))
        using (DeflateStream ds = new DeflateStream(ms, CompressionMode.Decompress))
        using (MemoryStream outMs = new MemoryStream()) { ds.CopyTo(outMs); inflated = outMs.ToArray(); }
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
        w = width; h = height;
        byte[] rgba = new byte[width * height * 4];
        for (int i = 0; i < width * height; i++)
        {
            rgba[i * 4] = img[i * channels];
            rgba[i * 4 + 1] = img[i * channels + 1];
            rgba[i * 4 + 2] = img[i * channels + 2];
            rgba[i * 4 + 3] = 255;
        }
        return rgba;
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    private static byte[] Crop(byte[] rgba, int w, int h, int x0, int y0, int cw, int ch)
    {
        byte[] outb = new byte[cw * ch * 4];
        for (int y = 0; y < ch; y++)
            for (int x = 0; x < cw; x++)
            {
                int sx = x0 + x, sy = y0 + y;
                if (sx >= 0 && sx < w && sy >= 0 && sy < h)
                    Buffer.BlockCopy(rgba, (sy * w + sx) * 4, outb, (y * cw + x) * 4, 4);
                else { outb[(y * cw + x) * 4 + 3] = 0; }
            }
        return outb;
    }
    private static byte[] Upscale3(byte[] rgba, int w, int h)
    {
        byte[] o = new byte[w * h * 9 * 4];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int si = (y * w + x) * 4;
                for (int dy = 0; dy < 3; dy++)
                    for (int dx = 0; dx < 3; dx++)
                        Buffer.BlockCopy(rgba, si, o, ((y * 3 + dy) * w * 3 + x * 3 + dx) * 4, 4);
            }
        return o;
    }

    public static string Run(string path)
    {
        StringBuilder sb = new StringBuilder();
        byte[] rgba; int w, h;
        rgba = Decode(path, out w, out h);

        // ---- STRUCTURE MAP: 12px cells ----
        int cell = 12, cw = (w + cell - 1) / cell, ch = (h + cell - 1) / cell;
        int[] bgM = new int[cw * ch], bgS = new int[cw * ch], surf = new int[cw * ch], oth = new int[cw * ch];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                int r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                int ci = (y / cell) * cw + (x / cell);
                int d9 = Math.Abs(r - 9) + Math.Abs(g - 9) + Math.Abs(b - 11);
                int d13 = Math.Abs(r - 13) + Math.Abs(g - 13) + Math.Abs(b - 16);
                if (d9 <= 14) bgM[ci]++;
                else if (d13 <= 14 || (Math.Abs(r - 12) + Math.Abs(g - 13) + Math.Abs(b - 16) <= 14)) bgS[ci]++;
                else
                {
                    int lum = (r * 299 + g * 587 + b * 114) / 1000;
                    int d17 = Math.Abs(r - 17) + Math.Abs(g - 17) + Math.Abs(b - 22);
                    int d23 = Math.Abs(r - 23) + Math.Abs(g - 23) + Math.Abs(b - 29);
                    if ((d17 <= 30 || d23 <= 30) && lum < 70) surf[ci]++;
                    else oth[ci]++;
                }
            }
        sb.AppendLine("STRUCTURE MAP (12px cells; ' '=main-bg '.'=sidebar-bg ':'=surface '#'=content):");
        sb.AppendLine("      " + Header(cw, cell));
        for (int yy = 0; yy < ch; yy++)
        {
            StringBuilder m = new StringBuilder();
            m.Append((yy * cell).ToString().PadLeft(4)).Append(" |");
            for (int xx = 0; xx < cw; xx++)
            {
                int i = yy * cw + xx;
                int tot = bgM[i] + bgS[i] + surf[i] + oth[i];
                char c = ' ';
                if (oth[i] * 100 >= tot * 25) c = '#';
                else if (surf[i] * 100 >= tot * 55) c = ':';
                else if (bgS[i] * 100 >= tot * 55) c = '.';
                else if (bgM[i] * 100 < tot * 90) c = '+';
                m.Append(c);
            }
            sb.AppendLine(m.ToString());
        }

        // ---- TOP-LEFT FINE MAPS (4px cells, x0-400 y0-220) ----
        int f = 4, fx0 = 0, fy0 = 0, fw = 100, fh = 55;
        int[] fv = new int[fw * fh], fb = new int[fw * fh], fbl = new int[fw * fh];
        for (int yy = 0; yy < fh; yy++)
            for (int xx = 0; xx < fw; xx++)
                for (int dy = 0; dy < f; dy++)
                    for (int dx = 0; dx < f; dx++)
                    {
                        int x = fx0 + xx * f + dx, y = fy0 + yy * f + dy;
                        if (x >= w || y >= h) continue;
                        int i = (y * w + x) * 4;
                        int r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                        int lum = (r * 299 + g * 587 + b * 114) / 1000;
                        int ci = yy * fw + xx;
                        if (b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) fv[ci]++;
                        if (lum >= 160) fb[ci]++;
                        if (!(b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) && b >= 130 && (b - r) >= 45 && (b - g) >= 20) fbl[ci]++;
                    }
        PrintMap(sb, "TOP-LEFT VIOLET (4px cells x0-400 y0-220)", fw, fh, f, fv, 8, 3);
        PrintMap(sb, "TOP-LEFT BRIGHT lum>=160 (4px cells)", fw, fh, f, fb, 9, 3);
        PrintMap(sb, "TOP-LEFT BLUE-nonviolet (4px cells)", fw, fh, f, fbl, 9, 3);

        // ---- SIDEBAR FULL MAP (8px cells x0-300 y0-900) ----
        int sc = 8, sw = 38, sh = 113;
        int[] sv = new int[sw * sh], sb2 = new int[sw * sh], sbl = new int[sw * sh];
        for (int yy = 0; yy < sh; yy++)
            for (int xx = 0; xx < sw; xx++)
                for (int dy = 0; dy < sc; dy++)
                    for (int dx = 0; dx < sc; dx++)
                    {
                        int x = xx * sc + dx, y = yy * sc + dy;
                        if (x >= w || y >= h) continue;
                        int i = (y * w + x) * 4;
                        int r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                        int lum = (r * 299 + g * 587 + b * 114) / 1000;
                        int ci = yy * sw + xx;
                        if (b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) sv[ci]++;
                        if (lum >= 155) sb2[ci]++;
                        if (!(b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) && b >= 130 && (b - r) >= 45 && (b - g) >= 20) sbl[ci]++;
                    }
        // combined sidebar map: V=violet, B=blue, .=bright, o=mid
        sb.AppendLine("SIDEBAR MAP (8px cells x0-300 y0-900; V=violet B=blue .bright o=mid):");
        sb.AppendLine("      " + Header(sw, sc));
        for (int yy = 0; yy < sh; yy++)
        {
            StringBuilder m = new StringBuilder();
            m.Append((yy * sc).ToString().PadLeft(4)).Append(" |");
            for (int xx = 0; xx < sw; xx++)
            {
                int ci = yy * sw + xx;
                char c = ' ';
                if (sv[ci] >= 4) c = 'V';
                else if (sbl[ci] >= 4) c = 'B';
                else if (sb2[ci] >= 4) c = '.';
                else if (sb2[ci] >= 1) c = 'o';
                m.Append(c);
            }
            sb.AppendLine(m.ToString());
        }

        // ---- MAIN HERO MAP (8px cells x280-1440 y280-640) ----
        int mc = 8, mx0 = 280, my0 = 280, mw = 145, mh = 45;
        int[] mv = new int[mw * mh], mb = new int[mw * mh], mbl = new int[mw * mh];
        for (int yy = 0; yy < mh; yy++)
            for (int xx = 0; xx < mw; xx++)
                for (int dy = 0; dy < mc; dy++)
                    for (int dx = 0; dx < mc; dx++)
                    {
                        int x = mx0 + xx * mc + dx, y = my0 + yy * mc + dy;
                        if (x >= w || y >= h) continue;
                        int i = (y * w + x) * 4;
                        int r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
                        int lum = (r * 299 + g * 587 + b * 114) / 1000;
                        int ci = yy * mw + xx;
                        if (b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) mv[ci]++;
                        if (lum >= 155) mb[ci]++;
                        if (!(b >= 170 && (b - r) >= 45 && (b - g) >= 65 && r >= 40 && r <= 215) && b >= 130 && (b - r) >= 45 && (b - g) >= 20) mbl[ci]++;
                    }
        PrintMap(sb, "MAIN VIOLET (8px cells x280-1440 y280-640)", mw, mh, mc, mv, 8, 4);
        PrintMap(sb, "MAIN BRIGHT lum>=155 (8px cells)", mw, mh, mc, mb, 9, 4);
        PrintMap(sb, "MAIN BLUE-nonviolet (8px cells)", mw, mh, mc, mbl, 9, 4);

        // ---- crops for OCR ----
        SavePng("C:/AI-Harness/_audit/crop_tl.png", 420, 220, Crop(rgba, w, h, 0, 0, 420, 220));
        SavePng("C:/AI-Harness/_audit/crop_side.png", 300, 900, Crop(rgba, w, h, 0, 0, 300, 900));
        SavePng("C:/AI-Harness/_audit/crop_hero.png", 1160, 360, Crop(rgba, w, h, 280, 280, 1160, 360));
        SavePng("C:/AI-Harness/_audit/crop_bottom.png", 300, 70, Crop(rgba, w, h, 0, 830, 300, 70));
        SavePng("C:/AI-Harness/_audit/crop_full.png", w, h, rgba);
        byte[] tl = Crop(rgba, w, h, 0, 0, 420, 220);
        SavePng("C:/AI-Harness/_audit/crop_tl3x.png", 1260, 660, Upscale3(tl, 420, 220));
        byte[] side = Crop(rgba, w, h, 0, 0, 300, 900);
        SavePng("C:/AI-Harness/_audit/crop_side3x.png", 900, 2700, Upscale3(side, 300, 900));
        byte[] hero = Crop(rgba, w, h, 280, 280, 1160, 360);
        SavePng("C:/AI-Harness/_audit/crop_hero3x.png", 3480, 1080, Upscale3(hero, 1160, 360));
        sb.AppendLine("CROPS WRITTEN");
        return sb.ToString();
    }

    private static void PrintMap(StringBuilder sb, string title, int fw, int fh, int f, int[] cells, int th, int tl)
    {
        sb.AppendLine(title + " (' '=0 '.'=1-" + tl + " '*'=" + (tl + 1) + "-" + th + " '#'=" + (th + 1) + "+):");
        sb.AppendLine("      " + Header(fw, f));
        for (int yy = 0; yy < fh; yy++)
        {
            StringBuilder m = new StringBuilder();
            m.Append((yy * f).ToString().PadLeft(4)).Append(" |");
            for (int xx = 0; xx < fw; xx++)
            {
                int v = cells[yy * fw + xx];
                m.Append(v > th ? '#' : v > tl ? '*' : v >= 1 ? '.' : ' ');
            }
            sb.AppendLine(m.ToString());
        }
    }

    private static string Header(int n, int cell)
    {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++)
        {
            string s = (i * cell).ToString();
            sb.Append(s.Length > 0 ? s[0] : ' ');
        }
        return sb.ToString();
    }
}
'@
Add-Type -TypeDefinition $src
[PixAudit3]::Run('C:/AI-Harness/_nexus_shot1.png')
