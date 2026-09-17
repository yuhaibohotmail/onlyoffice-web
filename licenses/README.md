# Original license texts (taken on 2026-08-30 from our own Community Edition container)

> English | [中文](README.zh.md)

We did not write these files; they are **the basis we rely on**. They were taken from a container of the image
**`onlyoffice/documentserver:9.4.0.1`** (Community Edition, AGPL),
at the path `/var/www/onlyoffice/documentserver/`.

| File | What it is |
|---|---|
| `onlyoffice-LICENSE.txt` | The full text of AGPL-3.0 **plus Ascensio's five additional terms**. This is the file meant by "together with the additional terms provided in the LICENSE file" in the headers of the source files |
| `api-js-header-community.txt` | The license notice at the top of `api.js` in the Community Edition |
| `api-js-header-de-derived.txt` | The notice in the same file in the upstream package, **identical word for word to the one above** |

## Why this file had to be obtained specifically

The 1.06 GB static package that comes with the upstream front-end-only project **does not contain a single OnlyOffice license file**
(the only two license files in the whole tree are Monaco's). Yet the source headers state explicitly that its terms apply "together with the additional terms provided in the LICENSE file".
**Without knowing what those five terms say, there is no way to state that we comply with them.** This gap is now filled.

## The five additional terms (supplementing the License under Section 7; failure to comply constitutes a violation of the License)

1. **Retention of notices and attribution**: copyright notices, license notices, warranty disclaimers, and attribution or origin notices must all be retained
2. **Modification notice**: modified versions must carry a prominent notice stating that they **have been modified** and the **date of modification**,
   and must **clearly indicate that they are based on ONLYOFFICE developed by Ascensio System SIA**
3. **Legal notices in the user interface**: where there is an interactive user interface, a **clearly accessible and prominently visible** user interface feature
   must enable users to: (i) identify ONLYOFFICE as the original developer; (ii) understand that the version in use may be a modified version;
   (iii) access the applicable license information
4. **No trademark rights granted**: no rights are granted to use its trademarks, service marks, trade names, **logos or branding**;
   trademarks are governed separately by <https://www.onlyoffice.com/trademark-policy>
5. **Non-code content is licensed separately**: illustrations, icon sets, documentation content and the like are under **CC BY-SA 4.0**

## Two facts found along the way

- **The Community Edition container has `sdkjs-plugins/`**: 11 plugins + `marketplace` + **`pluginBase.js`** + `v1`.
  When the previous round said "`pluginBase.js` is not in the package", that referred to **the upstream package**; if that directory is really needed,
  it can simply be taken from **our own Community Edition container**, without touching the commercial edition.
- **The license header of the Community Edition is identical word for word to that of the upstream DE-derived package**, which shows the code is the same;
  the difference lies in the **distribution terms**, not in the code.
