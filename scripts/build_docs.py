#!/usr/bin/env python3
"""Generate docs/index.html by listing all tools in tools/*.

Reads tools/<x>/metadata.json when it exists (otherwise it just uses the folder name) and produces a
static page. Browser tools are either Pyodide pages (`browser_entry`, optional `browser.html`) or a
prebuilt static web app (`browser_build`: folder with an index.html, copied to docs/<slug>/). Called by the `.github/workflows/pages.yml` workflow on each push to main.

Design: "scoreboard" identity shared with the per-tool pages — dark hardwood-court background,
amber readout accent, condensed display type for headings, monospace for numbers/stats/labels.
Keep this in sync with any per-tool `browser.html` if you touch the palette/type tokens below.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / "tools"
DOCS_DIR = ROOT / "docs"
DOCS_PY = DOCS_DIR / "py"

# ── shared design tokens ────────────────────────────────────────────────────
# bg #0f141b · surface #161d27 · line #232c38 · ink #eef2f6 · ink2 #93a1b3
# accent (readout amber) #ffb545 · accent2 (ball orange) #ff6a3d
BASE_STYLE = """
    :root{
        --bg:#0f141b; --surface:#161d27; --surface2:#1b2431; --line:#232c38;
        --ink:#eef2f6; --ink2:#93a1b3; --ink3:#5e6b7c;
        --amber:#ffb545; --orange:#ff6a3d;
    }
    *{box-sizing:border-box}
    body{
        font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        background:var(--bg); color:var(--ink); margin:0; padding:0 1.25rem 4rem;
        background-image:
            repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 120px);
    }
    .wrap{max-width:840px; margin:0 auto}
    .kicker{
        font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.72rem; letter-spacing:0.16em;
        text-transform:uppercase; color:var(--amber); margin:2.6rem 0 0.6rem;
    }
    h1{
        font-family:'Oswald',system-ui,sans-serif; font-weight:600; text-transform:uppercase;
        letter-spacing:0.01em; font-size:clamp(2rem,5vw,2.9rem); margin:0 0 0.5rem; line-height:1.05;
    }
    .sub{color:var(--ink2); margin:0 0 1.6rem; font-size:1rem; max-width:56ch; line-height:1.5}
    .net{
        height:10px; margin:0.4rem 0 2.2rem;
        background:
            repeating-linear-gradient(45deg, transparent 0 9px, var(--line) 9px 10px),
            repeating-linear-gradient(-45deg, transparent 0 9px, var(--line) 9px 10px);
        border-top:1px solid var(--line); border-bottom:1px solid var(--line);
        opacity:0.8;
    }
    a{color:var(--amber); text-decoration:none}
    a:hover{text-decoration:underline}
    a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible{
        outline:2px solid var(--amber); outline-offset:2px;
    }
    footer{
        margin-top:3rem; padding-top:1.2rem; border-top:1px solid var(--line);
        font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.78rem; color:var(--ink3);
        display:flex; gap:1.2rem; flex-wrap:wrap;
    }
    footer a{color:var(--ink2); margin-right:1.2rem}
    footer a:last-child{margin-right:0}
    @media (prefers-reduced-motion: reduce){ *{transition:none !important; animation:none !important} }
"""

FONT_LINKS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&'
    'family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">'
)

INDEX_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WorldAces Community Tools</title>
<meta name="description" content="Community-built tools for the WorldAces volleyball sim — scripts, charts and browser utilities, no install required.">
<meta name="viewport" content="width=device-width, initial-scale=1">
{font_links}
<style>
{base_style}
    .grid{{display:grid; gap:0.9rem}}
    .card{{
        position:relative; background:var(--surface); border:1px solid var(--line); border-radius:10px;
        padding:1.1rem 1.3rem 1.1rem 1.5rem; overflow:hidden;
    }}
    .card::before{{
        content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--orange);
    }}
    .card h2{{margin:0 0 0.35rem; font-family:'Oswald',sans-serif; font-weight:600; font-size:1.25rem; text-transform:uppercase; letter-spacing:0.01em}}
    .card h2 a{{color:var(--ink)}}
    .card h2 a:hover{{color:var(--amber); text-decoration:none}}
    .card p{{margin:0 0 0.7rem; color:var(--ink2); font-size:0.94rem; line-height:1.45}}
    .tags{{display:flex; gap:0.4rem; flex-wrap:wrap; margin-bottom:0.5rem}}
    .tags span{{
        font-family:'JetBrains Mono',monospace; font-size:0.68rem; letter-spacing:0.04em; text-transform:uppercase;
        background:var(--surface2); border:1px solid var(--line); color:var(--ink2);
        border-radius:999px; padding:0.22rem 0.6rem;
    }}
    .byline{{font-family:'JetBrains Mono',monospace; font-size:0.78rem; color:var(--ink3)}}
    .byline b{{color:var(--amber); font-weight:500}}
    .open{{font-family:'JetBrains Mono',monospace; font-size:0.8rem}}
</style>
</head>
<body>
<div class="wrap">
<p class="kicker">WorldAces &middot; community</p>
<h1>Community Tools</h1>
<p class="sub">Scripts and browser utilities built by players, for players. Pick a tool below\neach one runs on its own, no account needed.</p>
<div class="net" aria-hidden="true"></div>
<div class="grid">
{cards}
</div>
<footer>
    <a href="https://github.com/{repo}">Repository</a>
    <a href="https://github.com/{repo}/blob/main/CONTRIBUTING.md">Share a tool</a>
    <a href="https://github.com/{repo}/blob/main/LICENSE">MIT license</a>
</footer>
</div>
</body>
</html>
"""

CARD_TEMPLATE = """<div class="card">
    <h2><a href="{tool_page}">{name}</a></h2>
    <p>{description}</p>
    <div class="tags">{tags}</div>
    <p class="byline">by <b>{author}</b> &middot; <a class="open" href="{tool_page}">open tool &rarr;</a></p>
</div>
"""

PER_TOOL_HTML = """<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>__TITLE__ &mdash; WorldAces tools</title>
""" + FONT_LINKS + """
    <style>
""" + BASE_STYLE + """
        textarea{
            width:100%; min-height:220px; font-family:'JetBrains Mono',monospace; font-size:0.85rem;
            background:var(--surface2); color:var(--ink); border:1px solid var(--line); border-radius:8px;
            padding:0.8rem; resize:vertical;
        }
        .row{display:flex; gap:0.7rem; align-items:center; margin-top:0.7rem; flex-wrap:wrap}
        button, .btn{
            font-family:'Inter',sans-serif; font-weight:600; font-size:0.88rem; letter-spacing:0.01em;
            background:var(--amber); color:#241505; border:none; border-radius:7px; padding:0.6rem 1.1rem;
            cursor:pointer;
        }
        button.secondary{background:transparent; color:var(--ink2); border:1px solid var(--line)}
        select{background:var(--surface2); color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:0.4rem 0.6rem}
        canvas,img{max-width:100%; border:1px solid var(--line); border-radius:8px}
    </style>
</head>
<body>
    <div class="wrap">
    <p class="kicker">WorldAces &middot; __TITLE__</p>
    <h1>__TITLE__</h1>
    <p class="sub">Paste a JSON array (list of objects) or load a file, then click <em>Generate</em>.</p>
    <div class="net" aria-hidden="true"></div>

    <div class="row">
        <label for="file">Load a JSON/CSV file: </label>
        <input id="file" type="file" accept=".json,.csv" />
        <button class="secondary" id="loadExample" type="button">Load example</button>
    </div>

    <textarea id="input" placeholder='[ { "amount": 100, "source": "Salary" }, ... ]'></textarea>

    <div class="row">
        <label>Theme: <select id="theme"><option>light</option><option>dark</option></select></label>
        <button id="gen" type="button">Generate</button>
    </div>

    <h2 style="font-family:'Oswald',sans-serif;text-transform:uppercase;font-size:1.1rem;margin-top:2rem">Result</h2>
    <div id="output">No rendering yet</div>
    </div>

    <script type="module">
        const indexURL = 'https://cdn.jsdelivr.net/pyodide/v0.23.3/full/';
        let pyodide = null;
        let render_fn = null;

        document.getElementById('file').addEventListener('change', async (ev)=>{
            const f = ev.target.files[0];
            if(!f) return;
            const txt = await f.text();
            if(f.name.toLowerCase().endsWith('.csv')){
                const lines = txt.split(/\\r?\\n/).filter(Boolean);
                const headers = lines.shift().split(/,|;|\\t/).map(h=>h.trim());
                const arr = lines.map(l=>{
                    const cols = l.split(/,|;|\\t/);
                    const obj = {};
                    headers.forEach((h,i)=>obj[h]=cols[i]===undefined?"":cols[i]);
                    return obj;
                });
                document.getElementById('input').value = JSON.stringify(arr, null, 2);
            } else {
                document.getElementById('input').value = txt;
            }
        });

        document.getElementById('loadExample').addEventListener('click', ()=>{
            fetch('__EXAMPLE_PATH__').then(r=>r.text()).then(t=>document.getElementById('input').value=t).catch(()=>{
                document.getElementById('input').value = JSON.stringify([
                    {"amount": 1000, "source": "Salary"},
                    {"amount": -120, "source": "Groceries"},
                    {"amount": -60, "source": "Transport"},
                    {"amount": 200, "source": "Freelance"}
                ], null, 2);
            })
        });

        async function ensurePyodide(){
            if(pyodide) return;
            const load = document.createElement('div');
            load.id='loading';
            load.textContent = 'Loading Pyodide and matplotlib... (first load ~30-40 MB)';
            document.body.prepend(load);
            pyodide = await loadPyodide({indexURL});
            await pyodide.loadPackage(['micropip']);
            await pyodide.loadPackage(['matplotlib']);
            const pyCode = await (await fetch('__PY_PATH__')).text();
            pyodide.runPython(pyCode);
            render_fn = pyodide.globals.get('render_from_json');
            load.remove();
        }

        document.getElementById('gen').addEventListener('click', async ()=>{
            try{
                await ensurePyodide();
                const txt = document.getElementById('input').value.trim();
                if(!txt){ alert('Enter JSON or load a file'); return; }
                const theme = document.getElementById('theme').value;
                const pyres = render_fn(txt, theme, null, null, "", 150);
                const b64 = pyres.toString();
                document.getElementById('output').innerHTML = `<img alt="result" src="data:image/png;base64,${b64}" />`;
                pyres.destroy && pyres.destroy();
            }catch(e){
                console.error(e);
                alert('Error: '+e);
            }
        });

        (function(){
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/pyodide/v0.23.3/full/pyodide.js';
            s.onload = ()=>console.log('pyodide script loaded');
            document.head.appendChild(s);
        })();
    </script>
</body>
</html>
"""


def main():
        repo = "Worldaces-community/Worldaces-tools"
        cards = []
        DOCS_DIR.mkdir(exist_ok=True)
        DOCS_PY.mkdir(exist_ok=True)

        for tool_dir in sorted(TOOLS_DIR.iterdir()):
                if not tool_dir.is_dir():
                        continue
                meta_path = tool_dir / "metadata.json"
                if meta_path.exists():
                        meta = json.loads(meta_path.read_text())
                else:
                        meta = {"name": tool_dir.name, "description": "", "author": "?", "tags": []}

                slug = tool_dir.name
                tags = "".join(f"<span>{t}</span>" for t in meta.get("tags", []))

                # Create tool page if runnable_in_browser
                tool_page = f"https://github.com/{repo}/tree/main/tools/{slug}"
                browser_build = meta.get("browser_build")
                if meta.get("runnable_in_browser") and browser_build:
                        # Prebuilt static web app (e.g. a Node/TypeScript tool built by the Pages
                        # workflow with `npm run build:browser`): copied as-is to docs/<slug>/.
                        build_dir = tool_dir / browser_build
                        if (build_dir / "index.html").exists():
                                dest = DOCS_DIR / slug
                                shutil.rmtree(dest, ignore_errors=True)
                                shutil.copytree(build_dir, dest)
                                tool_page = f"{slug}/"
                        else:
                                print(f"warning: {slug}: {browser_build}/index.html not found (build step not run?)")
                elif meta.get("runnable_in_browser"):
                        py_src = tool_dir / meta.get("browser_entry", "browser.py")
                        if py_src.exists():
                                py_dest = DOCS_PY / f"{slug}_browser.py"
                                shutil.copy(py_src, py_dest)
                                py_path = f"py/{slug}_browser.py"
                        else:
                                py_path = ""

                        # copy example if present
                        example_src_candidates = [tool_dir / 'example_input.json', tool_dir / 'example.json']
                        example_path = ''
                        for c in example_src_candidates:
                                if c.exists():
                                        dst = DOCS_DIR / f"{slug}_example.json"
                                        shutil.copy(c, dst)
                                        example_path = f"{slug}_example.json"
                                        break

                        # Prefer a per-tool HTML page if provided in the tool folder (tools/<slug>/browser.html).
                        tool_html_src = tool_dir / 'browser.html'
                        if tool_html_src.exists():
                            raw = tool_html_src.read_text()
                            out = raw.replace('__TITLE__', meta.get('name', slug))
                            out = out.replace('__PY_PATH__', py_path if py_path else '')
                            out = out.replace('__EXAMPLE_PATH__', example_path or '#')
                            page_file = DOCS_DIR / f"{slug}.html"
                            page_file.write_text(out)
                            tool_page = f"{slug}.html"
                        elif not py_path:
                            tool_page = f"https://github.com/{repo}/tree/main/tools/{slug}"
                        else:
                            page_file = DOCS_DIR / f"{slug}.html"
                            page_file.write_text(PER_TOOL_HTML.replace('__TITLE__', meta.get('name', slug))
                                                    .replace('__PY_PATH__', py_path)
                                                    .replace('__EXAMPLE_PATH__', example_path or '#'))
                            tool_page = f"{slug}.html"

                cards.append(CARD_TEMPLATE.format(
                        tool_page=tool_page, name=meta.get("name", slug), description=meta.get("description", ""),
                        tags=tags, author=meta.get("author", "?"),
                ))

        (DOCS_DIR / "index.html").write_text(
                INDEX_TEMPLATE.format(cards="\n".join(cards), repo=repo, font_links=FONT_LINKS, base_style=BASE_STYLE)
        )
        print(f"wrote docs/index.html with {len(cards)} tool(s)")


if __name__ == "__main__":
        main()
