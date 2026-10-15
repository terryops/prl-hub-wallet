from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import struct

root = Path(__file__).parent
manifest = json.loads((root / 'dist' / 'manifest.json').read_text())
filename = f"pearl-hub-wallet-{manifest['version']}.zip"
store_icon = root / 'store' / 'icon-128.png'
if store_icon.exists():
    icon_bytes = store_icon.read_bytes()
    if icon_bytes[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', icon_bytes[16:24]) != (128, 128):
        raise ValueError('Store icon must be a 128x128 PNG')
def package(name, store=False):
    with ZipFile(root / name, 'w', ZIP_DEFLATED) as archive:
        for path in sorted((root / 'dist').rglob('*')):
            if path.is_file():
                relative = path.relative_to(root / 'dist')
                if store and relative == Path('manifest.json'):
                    # The Chrome Web Store assigns the item's own ID and rejects a "key" field;
                    # the website package keeps the fixed development ID.
                    archive.writestr(str(relative), json.dumps({k: v for k, v in manifest.items() if k != 'key'}, indent=2, ensure_ascii=False) + '\n')
                    continue
                # Keep normal development packaging working before outside-sandbox
                # screenshots exist; use the store-sized logo when it is available.
                archive.write(store_icon if relative == Path('icon.png') and store_icon.exists() else path, relative)
package(filename)
store_name = f"pearl-hub-wallet-{manifest['version']}-store.zip"
package(store_name, store=True)
print(filename)
print(store_name)
