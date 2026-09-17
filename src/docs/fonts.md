# Font Configuration

> English | [中文](fonts.zh.md)

[← Notes and Formats](./notes-and-formats.md) | [Comments and Revisions →](./comments-revisions-word-api.md)

Official documents, contracts, and similar scenarios often rely on system fonts such as **仿宋 (FangSong), 楷体 (KaiTi), and 方正小标宋 (FZ XiaoBiaoSong)**. The OnlyOffice static SDK ships with only some glyphs by default; for documents to display and export correctly, custom fonts need to be registered.

This component library performs registration through the SDK-side **`__custom_font_registry__`** (also referred to below as the **register font / font registry**), together with **`ttf-to-catalog-font.mjs`**, which converts TTF/OTF into the catalog wire format that OnlyOffice can load.

> Font files must comply with the relevant license agreements; do not upload glyphs you are not licensed to use.

## How It Works

```
TTF/OTF  ──ttf-to-catalog-font.mjs──►  fonts/{id} (extensionless catalog wire format)
                                              ▲
__custom_font_registry__  ──AllFonts.js──►  __fonts_files / __fonts_infos
                                              │
                                         editor resolves font names in the document by alias
```

1. Encode the source font as `public/packages/onlyoffice/9.4.0-develop/fonts/{id}` (**no extension**).
2. In `window["__custom_font_registry__"]` in `AllFonts.js`, use `{id}` as the key and an array of the font names that appear in documents as the aliases.
3. When the SDK loads `AllFonts.js`, it automatically syncs the registry into `__fonts_files` / `__fonts_infos`, and the Word / Excel / Slide pipelines match fonts by alias.

## Step 1: Convert TTF/OTF to the Catalog Wire Format

### Script Location

| Path | Description |
|------|------|
| `public/packages/onlyoffice/9.4.0-develop/fonts/ttf-to-catalog-font.mjs` | In the same directory as the SDK; used directly at deployment |
| `src/components/onlyoffice-web-comp/scripts/fonts/ttf-to-catalog-font.mjs` | Copy inside the component library, for version control |

Put the source font in the same directory as the script (e.g. `1001.ttf`), or pass the path explicitly:

```bash
# Read 1001.ttf from the same directory → public/packages/onlyoffice/9.4.0-develop/fonts/1001
node public/packages/onlyoffice/9.4.0-develop/fonts/ttf-to-catalog-font.mjs --id 1001 --verify

# Specify the source file
node public/packages/onlyoffice/9.4.0-develop/fonts/ttf-to-catalog-font.mjs ./MyFont.ttf --id 1001 --verify
```

The output is a catalog file with **no extension**:

```
public/packages/onlyoffice/9.4.0-develop/fonts/1001
```

`--verify` decodes the output to check that the wire format is correct. The script also prints maintenance hints to the console, such as the `__fonts_files` index and the `__fonts_infos` row.

### Common Parameters

```bash
node .../ttf-to-catalog-font.mjs <input.ttf> --id <fileId> [--out <path>] [--verify]
node .../ttf-to-catalog-font.mjs --decode --id <fileId>   # Decode to verify
```

- `--id`: matches the file name under `fonts/` and the key in `__custom_font_registry__` (a numeric string such as `"1001"` is recommended, to avoid conflicts with built-in indexes).
- `--out` / `--fonts-dir`: output directory; defaults to `public/packages/onlyoffice/9.4.0-develop/fonts/`.
- `--allfonts`: path to `AllFonts.js`; after encoding, the catalog entry can be patched automatically.

## Step 2: Register Aliases in `__custom_font_registry__`

Edit:

`public/packages/onlyoffice/9.4.0-develop/sdkjs/common/AllFonts.js`

Append entries to the registry object in the file (this repository already includes some official-document font examples):

```javascript
window["__custom_font_registry__"] = {
  "1001": [
    "仿宋_GB2312",
    "FangSong_GB2312",
    "Slidefu",
    "Slidefu Regular",
    "演示佛系体",
  ],
  "1002": ["FZXiaoBiaoSong-B05S", "方正小标宋简体"],
  // ...
};
```

| Field | Requirement |
|------|------|
| **Key** (e.g. `"1001"`) | Must match the `--id` from Step 1 and the catalog file name under `fonts/` |
| **Value** (alias array) | Must cover the **font names actually used** in Word / Excel / PPT documents; it is recommended to include the English name, the Chinese name, the name embedded in slides, and so on |

After the registry definition, `AllFonts.js` runs sync logic that writes the custom ids into `__fonts_files` and `__fonts_infos`; there is no need to call a separate `registerFont()` API in business code.

### How to Write Aliases

1. Open a sample document in Word and check the **display name** in the "Font" panel.
2. When you run `ttf-to-catalog-font.mjs`, the console prints the TTF's internal family name; add it to the aliases as well.
3. The same typeface may have different names in Word / Excel / Slide; **it is better to list extra aliases than to miss one**.

## Step 3: Replacing Built-in Fonts (Optional)

Built-in SDK glyphs are referenced by **numeric index** in `__fonts_files` in `AllFonts.js`. To replace a built-in glyph:

1. Find the target index in the `__fonts_files` array.
2. Place the catalog wire-format file at `public/packages/onlyoffice/9.4.0-develop/fonts/{index}` (no extension).

For custom fonts, prefer **non-numeric or high-numbered ids** (e.g. `1001`, `1002`) to avoid conflicts with built-in indexes.

## Verification Checklist

- [ ] The `fonts/{id}` file exists with no extension, and `--verify` passes
- [ ] The key in `__custom_font_registry__` matches `{id}`
- [ ] The aliases include every font name that appears in the documents
- [ ] With `pnpm dev` locally, open a document that uses the font; glyphs in the editing area and in the exported file match
- [ ] After deployment, the static resource path matches `STATIC_RESOURCE.onlyoffice.root` (can be overridden with `NEXT_PUBLIC_APP_ROOT`)

## Related Files

| File | Purpose |
|------|------|
| `sdkjs/common/AllFonts.js` | `__custom_font_registry__`, built-in `__fonts_files` / `__fonts_infos` |
| `fonts/{id}` | Catalog wire-format glyph data |
| `fonts/ttf-to-catalog-font.mjs` | TTF/OTF ↔ catalog conversion tool |
