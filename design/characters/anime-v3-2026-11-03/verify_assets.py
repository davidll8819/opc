"""Read-only PNG checks for paired character assets; writes the verification report only."""
from pathlib import Path
import hashlib
import json
import struct
import zlib

ROOT = Path(__file__).resolve().parent

def inspect_png(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', path
    w, h, depth, color, compression, method, interlace = struct.unpack('>IIBBBBB', data[16:29])
    assert (depth, color, compression, method, interlace) == (8, 6, 0, 0, 0), (path, depth, color)
    pos, compressed = 8, []
    while pos < len(data):
        n = struct.unpack('>I', data[pos:pos + 4])[0]
        chunk = data[pos + 4:pos + 8 + n]
        crc = struct.unpack('>I', data[pos + 8 + n:pos + 12 + n])[0]
        assert zlib.crc32(chunk) & 0xffffffff == crc, path
        if chunk[:4] == b'IDAT':
            compressed.append(chunk[4:])
        pos += n + 12
    raw = zlib.decompress(b''.join(compressed))
    stride = w * 4
    assert len(raw) == h * (stride + 1)
    previous, hist, corners, columns = bytearray(stride), [0] * 256, [], [0, 0, 0]
    for y in range(h):
        offset = y * (stride + 1)
        ft, row = raw[offset], bytearray(raw[offset + 1:offset + 1 + stride])
        assert ft in range(5)
        # Reconstruct alpha only. PNG byte filters preserve channel alignment.
        for x in range(3, stride, 4):
            a = row[x - 4] if x >= 4 else 0
            b = previous[x]
            c = previous[x - 4] if x >= 4 else 0
            if ft == 0:
                pred = 0
            elif ft == 1:
                pred = a
            elif ft == 2:
                pred = b
            elif ft == 3:
                pred = (a + b) // 2
            else:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else b if pb <= pc else c
            row[x] = (row[x] + pred) & 255
        alpha = row[3::4]
        for x, value in enumerate(alpha):
            hist[value] += 1
            if value >= 240:
                columns[min(2, x * 3 // w)] += 1
        if y in (0, h - 1):
            corners.extend([alpha[0], alpha[-1]])
        previous = row
    pixels = w * h
    assert hist[0] / pixels > .15, ('No substantial fully transparent region', path)
    assert sum(hist[240:]) / pixels > .15, ('Insufficient solid character area', path)
    return {
        'file': str(path.relative_to(ROOT)), 'width': w, 'height': h,
        'mode': 'RGBA', 'sha256': hashlib.sha256(data).hexdigest(),
        'fullyTransparentPercent': round(hist[0] / pixels * 100, 2),
        'nearOpaquePercent': round(sum(hist[240:]) / pixels * 100, 2),
        'cornerAlpha': corners, 'opaquePixelsInThirds': columns,
        'alphaVerified': True, 'pngCrcVerified': True,
    }

def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    chars = manifest['characters']
    assert len(chars) == 12 and len({c['assetGroupId'] for c in chars}) == 12
    assert len({c['characterId'] for c in chars}) == 12
    reports, files = [], set()
    for c in chars:
        if c['runtimeInstalled']:
            assert c['scenePreview']['employeeId']
            assert len(c['scenePreview']['motionAssets']) == 3
            assert c['scenePreview']['scope'] == 'office-visual-only'
            assert c['scenePreview']['portraitInstalled'] is False
        for kind in ('portrait', 'office'):
            asset = c[kind]
            assert asset['file'] not in files
            files.add(asset['file'])
            report = inspect_png(ROOT / asset['file'])
            if kind == 'office':
                assert asset['animationReady'] is False
                assert report['width'] > report['height']
                assert min(report['opaquePixelsInThirds']) > 10000
            report.update(characterId=c['characterId'], assetGroupId=c['assetGroupId'], kind=kind)
            reports.append(report)
            print('PASS', c['name'], kind, str(report['width']) + 'x' + str(report['height']),
                  str(report['fullyTransparentPercent']) + '% transparent', flush=True)
    assert len(reports) == 24
    (ROOT / 'paired-assets-verification.json').write_text(json.dumps({
        'method': 'PNG CRC, IDAT decompression, per-pixel alpha reconstruction, group and path uniqueness',
        'pairs': 12, 'files': 24, 'passed': True, 'assets': reports,
        'limitations': 'Static design checks only; no animation, runtime-size, or scene-occlusion test.'
    }, ensure_ascii=False, indent=2) + '\n')
    print('PASS: 12 pairs / 24 transparent PNGs. No images or application files modified.')

if __name__ == '__main__':
    main()

