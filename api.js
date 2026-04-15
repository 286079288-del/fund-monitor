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

    // 查询基金净值（最近N天）
    async getFundNav(ts_code, days = 10) {
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

    // 查询基金持仓
    async getFundPortfolio(ts_code) {
        const data = await this.call('fund_portfolio', { ts_code }, 'ts_code,symbol,mkv,stk_mkv_ratio');
        return this.parseFields(data);
    },

    // 获取新闻 — 通过 CORS 代理访问多个源
    async getNews(src) {
        const results = [];
        const sources = [
            { name: 'cls', label: '财联社', fn: () => this._fetchCLS() },
            { name: 'eastmoney', label: '东方财富', fn: () => this._fetchEastMoney() },
            { name: 'sina', label: '新浪财经', fn: () => this._fetchSina() },
            { name: 'wallstreetcn', label: '华尔街见闻', fn: () => this._fetchWallstreetCN() }
        ];

        // 优先用户选的源
        const ordered = [
            ...sources.filter(s => s.name === src),
            ...sources.filter(s => s.name !== src)
        ];

        for (const source of ordered) {
            try {
                const items = await source.fn();
                if (items && items.length > 0) {
                    items.forEach(item => { item._source = source.label; });
                    return items;
                }
            } catch (e) {
                console.warn(`${source.label} 获取失败:`, e.message);
            }
        }
        return results;
    },

    // CORS 代理
    async _corsFetch(url) {
        // 尝试多个 CORS 代理
        const proxies = [
            u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
            u => `https://corsproxy.io/?${encodeURIComponent(u)}`
        ];
        for (const makeProxy of proxies) {
            try {
                const proxyUrl = makeProxy(url);
                const resp = await fetch(proxyUrl, { 
                    signal: AbortSignal.timeout(8000) 
                });
                if (resp.ok) {
                    return resp;
                }
            } catch (e) {
                console.warn('CORS proxy failed:', e.message);
            }
        }
        throw new Error('所有CORS代理均不可用');
    },

    // 财联社快讯
    async _fetchCLS() {
        const resp = await this._corsFetch('https://www.cls.cn/api/subject/article/list?subject_id=0&page=1&rn=30');
        const json = await resp.json();
        if (!json?.data?.article_list) throw new Error('无数据');
        return json.data.article_list.map(a => ({
            datetime: new Date(a.ctime * 1000).toLocaleString('zh-CN'),
            content: a.brief || a.title || '',
            title: a.title || ''
        }));
    },

    // 东方财富7x24
    async _fetchEastMoney() {
        const resp = await this._corsFetch('https://np-alivio.eastmoney.com/np/interf/list/1000001.json?cb=&pageindex=0&pagesize=30&ut=7eea3edcaed734bea9004&dession=&fields=title,post_time,url');
        const json = await resp.json();
        if (!json?.data?.list) throw new Error('无数据');
        return json.data.list.map(item => ({
            datetime: item.post_time || '',
            content: item.title || '',
            title: item.title || ''
        }));
    },

    // 新浪财经7x24
    async _fetchSina() {
        const resp = await this._corsFetch('https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/sh000001.phtml');
        const text = await resp.text();
        const results = [];
        const regex = /<a[^>]*>([^<]+)<\/a>.*?(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/g;
        let m;
        while ((m = regex.exec(text)) && results.length < 30) {
            results.push({ datetime: m[2], content: m[1].trim(), title: '' });
        }
        if (results.length === 0) throw new Error('解析失败');
        return results;
    },

    // 华尔街见闻
    async _fetchWallstreetCN() {
        const resp = await this._corsFetch('https://wallstreetcn.com/api/v2/articles?page=1&channels=global');
        const json = await resp.json();
        if (!json?.data?.items) throw new Error('无数据');
        return json.data.items.map(a => ({
            datetime: new Date(a.created_at * 1000).toLocaleString('zh-CN'),
            content: a.description || a.title || '',
            title: a.title || ''
        }));
    },

    // 计算涨跌幅
    calcChange(navList) {
        if (!navList || navList.length < 2) return null;
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
    },

    // 判断是否在交易时间
    isTradingTime() {
        const now = new Date();
        const day = now.getDay();
        if (day === 0 || day === 6) return false;
        const h = now.getHours();
        const m = now.getMinutes();
        // 9:30-15:00
        const mins = h * 60 + m;
        return mins >= 570 && mins <= 900;
    },

    // 获取最新交易日日期描述
    getLastTradingDayInfo() {
        const now = new Date();
        const day = now.getDay();
        const h = now.getHours();
        const m = now.getMinutes();
        const mins = h * 60 + m;

        if (day === 0) return '上周五';
        if (day === 6) return '上周五';
        if (mins < 570) return '昨日';
        if (mins > 900) return '今日';
        return '今日';
    }
};
