// ===== 基金实时监控 - API 调用层 =====
const API_BASE = 'https://www.codebuddy.cn/v2/tool/financedata';

const FinanceAPI = {
    // 通用API调用
    async call(apiName, params, fields = '') {
        const body = { api_name: apiName, params };
        if (fields) body.fields = fields;
        try {
            const resp = await fetch(API_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            if (json.code !== 0) throw new Error(json.msg || '接口错误');
            return json.data;
        } catch (e) {
            console.error(`API调用失败 [${apiName}]:`, e);
            throw e;
        }
    },

    // 将 items 数组转为对象数组
    parseFields(data) {
        if (!data || !data.items || !data.items.length) return [];
        const fields = data.fields;
        return data.items.map(item => {
            const obj = {};
            fields.forEach((f, i) => obj[f] = item[i]);
            return obj;
        });
    },

    // 查询基金基础信息
    async getFundBasic(ts_code) {
        const data = await this.call('fund_basic', { ts_code }, 'ts_code,name,management,fund_type,type,invest_type,found_date');
        const items = this.parseFields(data);
        return items[0] || null;
    },

    // 查询基金净值（最近2天用于计算涨跌）
    async getFundNav(ts_code, days = 3) {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);
        const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
        const data = await this.call('fund_nav', {
            ts_code,
            start_date: fmt(start),
            end_date: fmt(end)
        }, 'ts_code,nav_date,unit_nav,accum_nav,adj_nav');
        return this.parseFields(data);
    },

    // 查询基金持仓（获取行业关联）
    async getFundPortfolio(ts_code) {
        const data = await this.call('fund_portfolio', { ts_code }, 'ts_code,symbol,mkv,stk_mkv_ratio');
        return this.parseFields(data);
    },

    // 获取新闻快讯 — 使用 WorkBuddy 代理抓取公开新闻API
    async getNews(src, startTime, endTime) {
        const pad = n => String(n).padStart(2, '0');
        const fmtTime = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        // 先尝试金融数据接口
        try {
            const data = await this.call('news', {
                src,
                start_date: fmtTime(startTime),
                end_date: fmtTime(endTime)
            }, '');
            const items = this.parseFields(data);
            if (items.length > 0) return items;
        } catch(e) {
            console.warn('金融数据新闻接口不可用，切换备用方案:', e.message);
        }
        // 备用方案：抓取公开新闻源
        return await this.fetchPublicNews(src);
    },

    // 备用：从公开API获取财经新闻
    async fetchPublicNews(src) {
        const results = [];
        const proxies = [
            // 华尔街见闻 公开快讯
            { name: 'wallstreetcn', fn: () => this._fetchWallstreetCN() },
            // 新浪财经7x24
            { name: 'sina', fn: () => this._fetchSinaFinance() },
            // 东方财富
            { name: 'eastmoney', fn: () => this._fetchEastMoney() }
        ];

        // 优先用用户选的源，否则按顺序尝试
        const ordered = [
            ...proxies.filter(p => p.name === src),
            ...proxies.filter(p => p.name !== src)
        ];

        for (const proxy of ordered) {
            try {
                const items = await proxy.fn();
                if (items && items.length > 0) {
                    console.log(`成功从 ${proxy.name} 获取 ${items.length} 条新闻`);
                    return items;
                }
            } catch(e) {
                console.warn(`${proxy.name} 获取失败:`, e.message);
            }
        }
        return results;
    },

    async _fetchWallstreetCN() {
        // 财联社快讯 (免费公开接口)
        const resp = await fetch('https://www.cls.cn/api/subject/article/list?subject_id=0&page=1&rn=30');
        const json = await resp.json();
        if (!json || !json.data || !json.data.article_list) throw new Error('无数据');
        return json.data.article_list.map(a => ({
            datetime: new Date(a.ctime * 1000).toLocaleString('zh-CN'),
            content: a.brief || a.title || '',
            title: a.title || ''
        }));
    },

    async _fetchSinaFinance() {
        // 新浪财经7x24
        const resp = await fetch('https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/sh000001.phtml');
        const text = await resp.text();
        // 简单解析
        const results = [];
        const regex = /<a[^>]*>([^<]+)<\/a>.*?(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/g;
        let m;
        while ((m = regex.exec(text)) && results.length < 30) {
            results.push({ datetime: m[2], content: m[1].trim(), title: '' });
        }
        if (results.length === 0) throw new Error('解析失败');
        return results;
    },

    async _fetchEastMoney() {
        // 东方财富7x24
        const now = Math.floor(Date.now() / 1000);
        const oneHourAgo = now - 3600 * 4;
        const resp = await fetch(`https://np-alivio.eastmoney.com/np/interf/list/1000001.json?cb=&pageindex=0&pagesize=30&ut=7eea3edcaed734bea9telecast&dession=&fields=title,post_time,url`);
        const json = await resp.json();
        if (!json || !json.data || !json.data.list) throw new Error('无数据');
        return json.data.list.map(item => ({
            datetime: item.post_time || '',
            content: item.title || '',
            title: item.title || ''
        }));
    },

    // 计算涨跌幅
    calcChange(navList) {
        if (!navList || navList.length < 2) return null;
        // 按日期排序（最新在前）
        const sorted = [...navList].sort((a, b) => b.nav_date.localeCompare(a.nav_date));
        const latest = parseFloat(sorted[0].unit_nav);
        const prev = parseFloat(sorted[1].unit_nav);
        if (!prev || prev === 0) return null;
        return {
            navDate: sorted[0].nav_date,
            currentNav: latest,
            prevNav: prev,
            change: ((latest - prev) / prev) * 100,
            changeAbs: latest - prev
        };
    }
};
