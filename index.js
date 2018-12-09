const express = require('express');
const app = express();
const rp = require('request-promise');
const Agent = require('socks5-https-client/lib/Agent');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const proxyURL = 'http://localhost:3000';
const fs = require('fs');
const compression = require('compression');
const cookieParser = require('cookie-parser');

app.use(compression());
app.use(cookieParser('miku'));

function enBase64(data){
    return Buffer.from(data).toString('base64');
}

function deBase64(data){
    return Buffer.from(data, 'base64').toString();
}

// 代理css里的内容
function proxyCss(CssText, origin, url, device){
    let proxyInlineCss = CssText.replace(/url\((.*?)\)/ig, (matches) => {
        let clippingUrl = /^url\((['"]?)(.*)\1\)$/.exec(matches);
        clippingUrl = clippingUrl ? clippingUrl[2] : "";
        const newUrl = (new URL(clippingUrl, url)).href;
        return `url("${proxyURL}/res/?url=${enBase64(newUrl)}&origin=${origin}&device=${device}")`;
    })
    return proxyInlineCss;
}

// 获取缓存
function getCache(filename, device){
    filename = filename.slice(0, 100);
    if(!fs.existsSync(`./cache/${device}/${filename}`)){
        return {
            code: 500
        };
    }else{
        let cacheData = fs.readFileSync('./cacheData.json');
        cacheData = JSON.parse(cacheData);
        let contentType = cacheData[device][filename].contentType;
        return {
            code: 200,
            data: fs.readFileSync(`./cache/${device}/${filename}`),
            contentType: contentType
        };
    }
}

// 创建缓存
function createCache(filename, data, contentType, device){
    filename = filename.slice(0, 100);
    if(!fs.existsSync('./cache')){
        fs.mkdirSync('./cache');
        fs.mkdirSync('./cache/pc');
        fs.mkdirSync('./cache/phone');
    }
    if(!fs.existsSync('./cacheData.json')){
        fs.writeFileSync('./cacheData.json', '{"pc":{}, "phone":{}, "pad": {}}');
    }
    let cacheData = fs.readFileSync('./cacheData.json');
    cacheData = JSON.parse(cacheData);
    cacheData[device][filename] = {
        contentType: contentType,
        date: (new Date()).getTime()
    }
    fs.writeFileSync('./cacheData.json', JSON.stringify(cacheData));
    fs.writeFileSync(`./cache/${device}/${filename}`, data);
}

// 代理页面
app.get('/', async (req, res) => {
    if(!req.query.url){
        res.send('200')
        return false;
    }
    // 相关参数
    const url = deBase64(req.query.url);
    const origin = (new URL(url)).origin;
    const userAgent = req.headers['user-agent'];

    // 判断URL是否合法
    const patternURL = /https?:\/\/[a-z0-9_.:]+\/[-a-z0-9_:@&?=+,.!/~*%$]*(\.(html|htm|shtml))?/;
    if(!patternURL.test(url)){
        res.send('200')
        return false;
    }

    // 首次访问获取宽高
    const _w = parseInt(req.cookies._w);
    const _h = parseInt(req.cookies._h);
    if(!_w || !_h){
        res.send(`
        <html>
            <body>
                <script>
                    window.onload = function(){
                        document.cookie = '_w=' + window.screen.width;
                        document.cookie =  '_h=' + window.screen.height;
                        window.location.reload();
                    }
                </script>
            </body>
        </html>
        `)
        return false;
    }

    // 判断是什么设备
    const device = _w <= 700 ? 'phone' : 'pc';

    // 处理重定向
    const aHtml = await rp.get(url, {
        resolveWithFullResponse: true,
        agentClass: Agent,
        agentOptions: {
            socksHost: '127.0.0.1',
            socksPort: 1080
        },
        headers: {
            'User-Agent': userAgent
        }
    })

    // 判断是否有缓存
    let cache = getCache(enBase64(aHtml.request.uri.href), device);
    if(cache.code === 200){
        res.contentType(cache.contentType);
        res.send(cache.data);
        return false;
    }

    // 开始解析页面
    console.log('开始解析页面')
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // 设置UA
    await page.setUserAgent(userAgent);

    // 设置拦截器，在无头浏览器内运行时不加载图片和视频资源
    await page.setRequestInterception(true);
    page.on('request', interceptedRequest => {
        if (interceptedRequest.resourceType() === 'image' || interceptedRequest.resourceType() === 'media'){
            interceptedRequest.respond({
                status: 200,
                contentType: 'image/gif',
                body: Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64')
            })
        } else {
            interceptedRequest.continue();
        }
    });

    // 设置宽高
    await page.setViewport({
        height: 10000,
        width: _w
    });

    await page.goto(url, {waitUntil: 'networkidle2'});
    const windowHandle = await page.evaluateHandle(() => window);

    // 获取页面的所有内联CSS
    const allCssText = await page.evaluate((window) => {
        return new Promise((resolve, reject) => {
            try {
                let document = window.document;
                let css = [];
                for (let i=0; i<document.styleSheets.length; i++){
                    let sheet = document.styleSheets[i];
                    if(sheet.href !== null) continue;
                    let rules = ('cssRules' in sheet)? sheet.cssRules : sheet.rules;
                    if (rules){
                        css.push('\n/* Stylesheet : '+(sheet.href||'[inline styles]')+' */');
                        for (let j=0; j<rules.length; j++){
                            let rule = rules[j];
                            if ('cssText' in rule)
                                css.push(rule.cssText);
                            else
                                css.push(rule.selectorText+' {\n'+rule.style.cssText+'\n}\n');
                        }
                    }
                }
                resolve(css.join('\n'));
            } catch (error) {
                reject(error);
            }
        })
    }, windowHandle);

    // 解析后的页面
    const resultsHtml = await page.content();
    await browser.close();

    const $ = cheerio.load(resultsHtml);
    
    // 处理dom里的资源链接
    $('img').each(function(){
        const src = $(this).attr('src');
        if(src) $(this).attr('src', `${proxyURL}/res/?url=${enBase64(src)}&origin=${origin}&device=${device}`);
        $(this).removeAttr('srcset');
        $(this).addClass('lazyyyyyy');
        // $(this).removeAttr('src');
    })
    $('link[rel="stylesheet"]').each(function(){
        const src = $(this).attr('href');
        if(src) $(this).attr('href',`${proxyURL}/res/?url=${enBase64(src)}&origin=${origin}&device=${device}`);
    })
    $('link').each(function(){
        const attr = $(this).attr('rel');
        if(attr !== 'stylesheet'){
            $(this).remove();
        }
    })
    $('[style]').each(function(){
        const cssText = $(this).attr('style');
        $(this).attr('style', proxyCss(cssText, origin, url, device));
    })
    $('style').remove();
    $('script').remove();
    $('meta[property]').remove();
    $('head').append(`<style type="text/css">${proxyCss(allCssText, origin, url, device)}</style>`);
    // $('body').append(`<script src="https://cdnjs.loli.net/ajax/libs/vanilla-lazyload/10.19.0/lazyload.min.js"></script>`);
    $('body').append(`
        <script>
            document.querySelectorAll("*").forEach(function (c) {
                c.onclick = function (c) {
                    c.preventDefault()
                }
            })
            // new LazyLoad();
        </script>
    `)

    res.send($.html());
    createCache(enBase64(page.url()), $.html(), 'text/html', device);
});

// 代理资源文件
app.get('/res', async (req, res) => {
    const device = req.query.device; //设备信息
    
    //获取缓存
    let cache = getCache(req.query.url, device);
    if(cache.code === 200){
        res.contentType(cache.contentType);
        res.send(cache.data);
        return false;
    }

    // 获取相关参数
    let url = deBase64(req.query.url);
    let origin = deBase64(req.query.origin);
    const userAgent = req.headers['user-agent'];

    // 判断是否是dataURL
    if(url.indexOf('data') === 0){
        res.send(url);
        return false;
    }

    if(url.indexOf('http') === -1){
        url = (new URL(url, origin)).href;
    }

    // 请求资源
    const resources = await rp.get(url, {
        agentClass: Agent,
        agentOptions: {
            socksHost: '127.0.0.1',
            socksPort: 1080
        },
        headers: {
            'User-Agent': userAgent
        },
        resolveWithFullResponse: true,
        encoding: null
    })

    const contentType = resources.headers['content-type'];

    // 如果是css文件处理链接后再返回
    if(contentType === 'text/css'){
        const cssText = Buffer.from(resources.body).toString();
        res.setHeader("Content-Type", contentType);
        res.send(proxyCss(cssText, origin, url, device));
        return false;
    }
    res.setHeader("Content-Type", contentType);
    res.send(resources.body);
    createCache(req.query.url, resources.body, contentType, device);
})

// 错误处理
app.use(function(err, req, res, next) {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.listen('3000', () => {
    console.log('代理已启动');
});