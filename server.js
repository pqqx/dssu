const express = require('express');
const { chromium } = require('playwright');
const { Readable } = require('stream');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 裏で動かし続ける本物のブラウザインスタンス
let browser;

// CORS許可
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// フロントエンド（UI）の配信
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// メインのプロキシAPI
app.get('/api/fetch', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).send("No target URL specified.");

    try {
        const rawTarget = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;
        const safeUrlObject = new URL(rawTarget);
        
        // 元のロジック：まずは通常のfetchでコンテンツタイプやヘッダーを確認
        const fetchOptions = {
            method: req.method || 'GET',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            },
            redirect: 'follow'
        };

        const proxyRes = await fetch(safeUrlObject.toString(), fetchOptions);
        const finalUrl = proxyRes.url; 
        const mime = proxyRes.headers.get('content-type') || 'application/octet-stream';
        const isHtml = mime.includes('text/html');

        // Proxy稼働によるFrame表示・操作破壊を守る「引き算・リフレッシュ済み」ヘッダー洗浄
        for (const [key, value] of proxyRes.headers.entries()) {
            const lower = key.toLowerCase();
            const removals = ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'content-length', 'content-encoding', 'transfer-encoding'];
            if (!removals.includes(lower)) res.setHeader(key, value);
        }
        res.setHeader("Content-Type", mime);

        if (isHtml) {
            // =====================================
            // [アップグレード部分] JS完全レンダリングの実行
            // =====================================
            if (!browser) {
                return res.status(500).send("Browser is not initialized yet.");
            }

            const context = await browser.newContext({
                userAgent: fetchOptions.headers['User-Agent'],
                ignoreHTTPSErrors: true // SSLエラー等を無視
            });
            const page = await context.newPage();
            
            // ネットワーク通信が落ち着く（JSの描画が終わる）まで待機
            await page.goto(finalUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log("Navigation timeout or error, continuing...", e.message));
            
            // 描画完了後の完成済みHTMLを抽出
            let textContent = await page.content();
            const originalDataSize = Buffer.byteLength(textContent, 'utf-8');
            
            await context.close();

            // 元コードのスクリプト注入ロジック（一切省略・変更なし）
            const injectScript = `
        <base href="${finalUrl}">
        <script>
            // Eruda は親側と干渉や表示を阻害しない為、シンプル化を図り本件ではIframeからは直接起動しません

            function notify(payload) {
                if(window.parent !== window) window.parent.postMessage(payload, '*');
            }

            //[ドメイン例外でのiframe崩壊を防ぐ防御魔法。ここは消さない(モック必須)]
            try {
                window.history.pushState = function(){};
                window.history.replaceState = function(){};
            } catch(e) {}

            // 【完全監視 A】すべての<a>のクリック動作、及び階層化(ShadowDOM下やSVG被り等)の遷移ハック全てを遮断、自分自身(Proxy)を親に経由発火。
            document.addEventListener('click', function(e) {
                 const path = e.composedPath ? e.composedPath() : [];
                 const a = path.find(el => el.tagName === 'A') || e.target.closest('a');
                 if(a && a.href && !a.href.startsWith('javascript:')) {
                      e.preventDefault();
                      e.stopPropagation(); // 重ねるだけでなく上部へ一切逃さない処理
                      notify({ type: 'navigating-link', url: a.href });
                 }
            }, true); // useCaptureの絶対最上位権限を保ち続けます。

            // 【完全監視 B】すべての<form>による内部提出
            document.addEventListener('submit', function(e) {
                const form = e.target;
                if (form.action) {
                    e.preventDefault(); e.stopPropagation();
                    const formData = new FormData(form);
                    const isGet = !form.method || form.method.toUpperCase() === 'GET';
                    if (isGet) {
                        let queryUrl = new URL(form.action, document.baseURI);
                        for (let [key, val] of formData.entries()) queryUrl.searchParams.append(key, val);
                        notify({ type: 'navigating-link', url: queryUrl.href });
                    } else {
                        // シンプルな回避策
                        notify({ type: 'navigating-link', url: form.action });
                    }
                }
            }, true);

            // [本物の全要素容量抽出]: リクエストトラップは削除したが、集計の重み負担が無いこの部分は継続配置する
            let previouslyReportedBytes = 0;
            setInterval(() => {
                try {
                    let totalScanned = 0;
                    const items = window.performance.getEntriesByType('resource');
                    for (let i = 0; i < items.length; i++) totalScanned += (items[i].transferSize || items[i].encodedBodySize || 0);
                    
                    const differentialAdd = totalScanned - previouslyReportedBytes;
                    if (differentialAdd > 0) {
                         previouslyReportedBytes = totalScanned;
                         notify({ type: 'page-connected', size: differentialAdd }); 
                    }
                } catch(e) {}
            }, 3500);

            // プロキシ確立完了通信
            notify({ type: 'page-connected', url: '${finalUrl}', size: ${originalDataSize} });
        </script>
        `;

            if (textContent.includes('<head>')) { 
                textContent = textContent.replace('<head>', '<head>\n' + injectScript); 
            } else { 
                textContent = injectScript + '\n' + textContent; 
            }

            return res.status(200).send(Buffer.from(textContent, 'utf-8'));
            
        } else {
            // 元コードの超速スルーパスロジック（画像や他ストリーミングファイル）
            if (proxyRes.body) { return Readable.fromWeb(proxyRes.body).pipe(res); } 
            else { return res.status(proxyRes.status).end(); }
        }
    } catch(error) {
         return res.status(500).send("Playwright Pipeline Error: " + error.toString());
    }
});

// サーバー起動と同時にブラウザをスタンバイ
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    // サーバーレス環境（Render等）で必須のサンドボックス無効化フラグ
    browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log("Playwright headless browser is ready!");
});
