// ===== 基金实时监控 - 主应用逻辑 =====
const App = {
    refreshTimer: null,
    newsData: [],
    newsFilter: 'all',

    init() {
        DataManager.load();
        this.renderFundList();
        this.updateDashboard();
        this.bindEvents();
        this.showTradingStatus();
        this.startAutoRefresh();
        this.refreshAllFunds();
    },

    showTradingStatus() {
        const banner = document.getElementById('tradingStatus');
        if (!FinanceAPI.isTradingTime()) {
            const dayInfo = FinanceAPI.getLastTradingDayInfo();
            banner.innerHTML = `💤 当前非交易时间，显示的是 <strong>${dayInfo}</strong> 收盘数据。交易日 9:30-15:00 自动刷新。`;
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    },

    bindEvents() {
        document.getElementById('btnAddFund').addEventListener('click', () => this.openAddModal());
        document.getElementById('closeModal').addEventListener('click', () => this.closeAddModal());
        document.getElementById('btnCancelAdd').addEventListener('click', () => this.closeAddModal());
        document.getElementById('btnRefresh').addEventListener('click', () => this.refreshAllFunds());
        document.getElementById('btnSearchFund').addEventListener('click', () => this.searchFundInfo());
        document.getElementById('inputFundCode').addEventListener('keypress', e => { if (e.key === 'Enter') this.searchFundInfo(); });
        document.getElementById('btnConfirmAdd').addEventListener('click', () => this.confirmAddFund());
        document.getElementById('searchFund').addEventListener('input', e => this.renderFundList(e.target.value));
        document.getElementById('btnLoadNews').addEventListener('click', () => this.loadNews());
        document.querySelectorAll('.news-tabs .tab').forEach(tab => {
            tab.addEventListener('click', e => {
                document.querySelectorAll('.news-tabs .tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                this.newsFilter = e.target.dataset.filter;
                this.renderNews();
            });
        });
        document.getElementById('refreshInterval').addEventListener('change', () => this.startAutoRefresh());
    },

    openAddModal() {
        document.getElementById('addFundModal').classList.add('active');
        document.getElementById('inputFundCode').value = '';
        document.getElementById('inputAmount').value = '';
        document.getElementById('inputUpThreshold').value = '3';
        document.getElementById('inputDownThreshold').value = '-2';
        document.getElementById('inputKeywords').value = '';
        document.getElementById('searchResult').style.display = 'none';
        document.getElementById('btnConfirmAdd').disabled = true;
        this._pendingFund = null;
        document.getElementById('inputFundCode').focus();
    },
    closeAddModal() { document.getElementById('addFundModal').classList.remove('active'); },

    async searchFundInfo() {
        const code = document.getElementById('inputFundCode').value.trim();
        if (!code) return;
        let tsCode = code;
        if (!code.includes('.')) tsCode = code + '.OF';
        const resultDiv = document.getElementById('searchResult');
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:12px">查询中...</p>';
        try {
            const info = await FinanceAPI.getFundBasic(tsCode);
            if (info) {
                this._pendingFund = info;
                document.getElementById('fundInfoCard').innerHTML = `
                    <div class="info-row"><span class="info-label">代码</span><span class="info-value">${info.ts_code}</span></div>
                    <div class="info-row"><span class="info-label">名称</span><span class="info-value">${info.name}</span></div>
                    <div class="info-row"><span class="info-label">类型</span><span class="info-value">${info.fund_type||info.type||'-'}</span></div>
                    <div class="info-row"><span class="info-label">管理人</span><span class="info-value">${info.management||'-'}</span></div>`;
                document.getElementById('btnConfirmAdd').disabled = false;
            } else { resultDiv.innerHTML = '<p style="color:var(--color-danger);font-size:12px">未找到该基金</p>'; }
        } catch (e) { resultDiv.innerHTML = '<p style="color:var(--color-danger);font-size:12px">查询失败</p>'; }
    },

    confirmAddFund() {
        if (!this._pendingFund) return;
        const fund = {
            ts_code: this._pendingFund.ts_code,
            name: this._pendingFund.name,
            type: this._pendingFund.fund_type || '',
            management: this._pendingFund.management || '',
            amount: parseFloat(document.getElementById('inputAmount').value) || 0,
            upThreshold: parseFloat(document.getElementById('inputUpThreshold').value) || 3,
            downThreshold: parseFloat(document.getElementById('inputDownThreshold').value) || -2,
            keywords: document.getElementById('inputKeywords').value.split(/[,，]/).filter(k => k.trim())
        };
        if (DataManager.addFund(fund)) {
            this.showToast('success', '添加成功', fund.name);
            this.closeAddModal();
            this.refreshAllFunds();
        } else { this.showToast('warning', '重复', fund.name + ' 已在列表中'); }
    },

    // ===== 刷新 =====
    async refreshAllFunds() {
        const funds = DataManager.getFunds();
        if (!funds.length) return;

        const btn = document.getElementById('btnRefresh');
        const bar = document.getElementById('loadingBar');
        const barInner = document.getElementById('loadingBarInner');
        const progress = document.getElementById('refreshProgress');
        const statusEl = document.getElementById('refreshStatus');

        btn.disabled = true;
        btn.innerHTML = '⏳ 加载中...';
        bar.style.display = 'block';
        statusEl.textContent = '正在获取净值数据...';

        let upCount = 0, downCount = 0, flatCount = 0, alertCount = 0;
        let totalProfit = 0, totalUpProfit = 0, totalDownProfit = 0;
        let errorCount = 0, emptyCount = 0;

        const batchSize = 3;
        for (let i = 0; i < funds.length; i += batchSize) {
            const batch = funds.slice(i, i + batchSize);
            const done = Math.min(i + batchSize, funds.length);
            progress.textContent = `${done}/${funds.length}`;
            barInner.style.width = `${(done / funds.length) * 100}%`;

            const promises = batch.map(async (fund) => {
                try {
                    const navData = await FinanceAPI.getFundNav(fund.ts_code, 10);
                    if (!navData || navData.length === 0) {
                        fund._error = true;
                        fund._errorMsg = '暂无净值数据';
                        emptyCount++;
                        return;
                    }
                    DataManager.updateNav(fund.ts_code, navData);
                    const change = FinanceAPI.calcChange(navData);
                    fund._error = false;
                    fund._errorMsg = '';
                    if (change) {
                        fund._change = change;
                        if (change.change > 0) upCount++;
                        else if (change.change < 0) downCount++;
                        else flatCount++;
                        const profit = fund.amount ? fund.amount * change.change / 100 : 0;
                        if (profit > 0) totalUpProfit += profit;
                        else totalDownProfit += profit;
                        totalProfit += profit;
                        if (change.change >= fund.upThreshold || change.change <= fund.downThreshold) {
                            alertCount++;
                            fund._alert = true;
                            this.showToast('warning', fund.name.substring(0,10)+'...',
                                `涨跌 ${(change.change>0?'+':'')}${change.change.toFixed(2)}%  盈亏 ¥${profit.toFixed(2)}`);
                        }
                    } else {
                        fund._change = null;
                        flatCount++;
                    }
                } catch (e) {
                    fund._error = true;
                    fund._errorMsg = '查询失败';
                    fund._change = null;
                    errorCount++;
                }
            });
            await Promise.allSettled(promises);
            this.renderFundList();
        }

        barInner.style.width = '100%';
        progress.textContent = `${funds.length}/${funds.length} ✓`;

        const totalAsset = funds.reduce((s, f) => s + (f.amount || 0), 0);
        document.getElementById('totalAsset').textContent = `¥${totalAsset.toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        const profitEl = document.getElementById('todayProfit');
        profitEl.textContent = `${totalProfit >= 0 ? '+' : ''}¥${totalProfit.toFixed(2)}`;
        profitEl.className = 'strong ' + (totalProfit > 0 ? 'up' : totalProfit < 0 ? 'down' : '');

        this.updateDashboard({ upCount, downCount, flatCount, alertCount, totalUpProfit, totalDownProfit });

        const dayInfo = FinanceAPI.getLastTradingDayInfo();
        let statusText = `${dayInfo}数据 · `;
        if (errorCount > 0) statusText += `${errorCount}个查询失败 · `;
        statusText += `更新于 ${new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}`;
        statusEl.textContent = statusText;

        document.getElementById('lastUpdate').textContent = new Date().toLocaleString('zh-CN');
        setTimeout(() => { bar.style.display = 'none'; barInner.style.width = '0'; }, 1000);
        btn.disabled = false;
        btn.innerHTML = '🔄 刷新净值';
        DataManager.save();
    },

    // ===== 渲染 =====
    renderFundList(searchText = '') {
        const container = document.getElementById('fundList');
        const funds = DataManager.getFunds();
        if (!funds.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>还没有添加任何基金</p><p class="empty-hint">点击「+ 添加基金」开始</p></div>';
            return;
        }
        const filtered = funds.filter(f => {
            if (!searchText) return true;
            const s = searchText.toLowerCase();
            return f.ts_code.toLowerCase().includes(s) || f.name.toLowerCase().includes(s);
        });
        if (!filtered.length) {
            container.innerHTML = '<div class="empty-state"><p>没有匹配的基金</p></div>';
            return;
        }

        let html = `<table class="fund-table"><thead><tr>
            <th>基金名称</th><th class="num">最新净值</th><th class="num">日期</th><th class="change">涨跌幅</th><th class="amount">持仓</th><th class="profit">盈亏</th><th class="act"></th>
        </tr></thead><tbody>`;

        filtered.forEach(fund => {
            const change = fund._change || FinanceAPI.calcChange(fund.navData);
            const dir = change ? (change.change > 0 ? 'up' : change.change < 0 ? 'down' : 'flat') : '';
            const changeStr = change ? `${change.change>0?'+':''}${change.change.toFixed(2)}%` : '--';
            const navStr = change ? change.currentNav.toFixed(4) : (fund.navData && fund.navData.length ? parseFloat(fund.navData[0].unit_nav).toFixed(4) : '--');
            const navDateStr = change ? this._fmtDate(change.navDate) : (fund.navData && fund.navData.length ? this._fmtDate(fund.navData[fund.navData.length-1].nav_date) : '--');
            const rowClass = fund._alert ? 'alert-row' : fund._error ? 'error-row' : '';
            const profit = fund.amount && change ? fund.amount * change.change / 100 : null;
            const profitStr = profit !== null ? `${profit>=0?'+':''}${profit.toFixed(2)}` : '--';
            const profitDir = profit !== null ? (profit > 0 ? 'up' : profit < 0 ? 'down' : '') : '';
            const alertTag = fund._alert ? '<span class="fund-alert-tag">⚠️</span>' : '';
            const errorTag = fund._error ? '<span class="fund-error-tag" title="'+(fund._errorMsg||'查询失败')+'">❌</span>' : '';
            const shortName = fund.name.length > 14 ? fund.name.substring(0,14)+'...' : fund.name;

            html += `<tr class="${rowClass}">
                <td><div class="fund-name-cell"><span class="fund-name-text" title="${fund.name}">${shortName}${alertTag}${errorTag}</span><span class="fund-code-text">${fund.ts_code}</span></div></td>
                <td class="num"><span class="fund-nav-val">${navStr}</span></td>
                <td class="num nav-date-cell">${navDateStr}</td>
                <td class="fund-change-cell"><span class="fund-change-val ${dir}">${changeStr}</span></td>
                <td class="num"><span class="fund-amount-val">${fund.amount ? '¥'+fund.amount.toLocaleString() : '--'}</span></td>
                <td class="num"><span class="fund-profit-val ${profitDir}">${profitStr}</span></td>
                <td class="act"><button class="fund-act-btn" title="删除" onclick="App.removeFund('${fund.ts_code}')">×</button></td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    },

    _fmtDate(d) {
        if (!d || d.length < 8) return d || '--';
        return d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8);
    },

    removeFund(tsCode) {
        const fund = DataManager.getFunds().find(f => f.ts_code === tsCode);
        if (fund && confirm(`删除 ${fund.name}？`)) {
            DataManager.removeFund(tsCode);
            this.renderFundList();
            this.showToast('success', '已删除', fund.name);
        }
    },

    updateDashboard(c) {
        const funds = DataManager.getFunds();
        document.getElementById('statTotal').textContent = funds.length;
        if (c) {
            document.getElementById('statUp').textContent = c.upCount;
            document.getElementById('statDown').textContent = c.downCount;
            document.getElementById('statFlat').textContent = c.flatCount;
            document.getElementById('statAlert').textContent = c.alertCount;
            document.getElementById('statUpTotal').textContent = c.totalUpProfit > 0 ? `+¥${c.totalUpProfit.toFixed(0)}` : '';
            document.getElementById('statDownTotal').textContent = c.totalDownProfit < 0 ? `¥${c.totalDownProfit.toFixed(0)}` : '';
        }
    },

    // ===== 新闻 =====
    async loadNews() {
        const src = document.getElementById('newsSource').value;
        const btn = document.getElementById('btnLoadNews');
        const newsContainer = document.getElementById('newsList');
        btn.disabled = true; btn.textContent = '加载中...';
        newsContainer.innerHTML = '<div class="empty-state"><p>🔄 正在获取新闻...</p><p class="empty-hint">尝试多个新闻源，请稍候</p></div>';
        try {
            const news = await FinanceAPI.getNews(src);
            if (news.length === 0) {
                newsContainer.innerHTML = '<div class="empty-state"><div class="empty-icon">📰</div><p>暂无新闻数据</p><p class="empty-hint">可能是网络或跨域限制，请稍后重试</p></div>';
            } else {
                this.newsData = this.enrichNews(news);
                this.renderNews();
                document.getElementById('statNews').textContent = this.newsData.length;
            }
        } catch (e) {
            newsContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><p>加载失败</p><p class="empty-hint">${e.message}</p></div>`;
            this.showToast('danger', '新闻加载失败', e.message);
        }
        btn.disabled = false; btn.textContent = '加载';
    },

    enrichNews(news) {
        const keywords = DataManager.getAllKeywords();
        const funds = DataManager.getFunds();
        return news.map(item => {
            const content = item.content || item.title || '';
            const matched = [];
            let sentiment = 'neutral';
            NEGATIVE_KEYWORDS.forEach(kw => { if (content.includes(kw)) { sentiment = 'negative'; matched.push({word:kw,type:'neg'}); }});
            POSITIVE_KEYWORDS.forEach(kw => { if (content.includes(kw)) { if(sentiment!=='negative')sentiment='positive'; matched.push({word:kw,type:'pos'}); }});
            keywords.forEach(kw => { if (content.includes(kw) && !matched.find(m=>m.word===kw)) matched.push({word:kw,type:'alert'}); });
            const matchedFunds = funds.filter(f => f.keywords && f.keywords.some(kw => content.includes(kw)));
            return { ...item, sentiment, matchedKeywords:matched, matchedFunds:matchedFunds.map(f=>f.name), isAlert:sentiment==='negative'&&matched.length>0 };
        });
    },

    renderNews() {
        const container = document.getElementById('newsList');
        if (!this.newsData.length) { container.innerHTML = '<div class="empty-state"><div class="empty-icon">📰</div><p>暂无新闻</p></div>'; return; }
        let filtered = this.newsData;
        if (this.newsFilter==='alert') filtered=this.newsData.filter(n=>n.isAlert);
        else if (this.newsFilter==='negative') filtered=this.newsData.filter(n=>n.sentiment==='negative');
        else if (this.newsFilter==='positive') filtered=this.newsData.filter(n=>n.sentiment==='positive');
        if (!filtered.length) { container.innerHTML = '<div class="empty-state"><p>该分类暂无新闻</p></div>'; return; }
        container.innerHTML = filtered.map(item => {
            const c = (item.content||item.title||'').substring(0,120) + ((item.content||'').length>120?'...':'');
            const kwHtml = (item.matchedKeywords||[]).map(k=>`<span class="news-keyword ${k.type}">${k.word}</span>`).join('');
            const fHtml = (item.matchedFunds&&item.matchedFunds.length) ? `<div class="news-match-funds">🔗 ${item.matchedFunds.join(', ')}</div>` : '';
            const src = item._source || '';
            return `<div class="news-item ${item.sentiment==='negative'?'negative':item.sentiment==='positive'?'positive':''} ${item.isAlert?'alert':''}">
                <div class="news-time">${item.datetime||'--'}${src ? '<span class="news-source">'+src+'</span>' : ''}</div>
                <div class="news-content">${c}</div>
                ${kwHtml?`<div class="news-keywords">${kwHtml}</div>`:''}${fHtml}</div>`;
        }).join('');
    },

    startAutoRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        const interval = parseInt(document.getElementById('refreshInterval').value) * 1000;
        if (interval > 0) this.refreshTimer = setInterval(() => this.refreshAllFunds(), interval);
    },

    showToast(type, title, msg) {
        const container = document.getElementById('toastContainer');
        const icons = {success:'✅',warning:'⚠️',danger:'❌'};
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type]||'📢'}</span><div class="toast-body"><div class="toast-title">${title}</div><div class="toast-msg">${msg||''}</div></div>`;
        container.appendChild(toast);
        setTimeout(() => { toast.style.animation='toast-out .25s ease forwards'; setTimeout(()=>toast.remove(),250); }, 5000);
    }
};

// ===== 预置基金 =====
function initDefaultFunds() {
    const data = DataManager.load();
    if (data.funds.length > 0) return;
    const defaults = [
        {ts_code:'013402.OF',name:'华夏恒生科技ETF联接(QDII)A',type:'股票型',amount:15595.90,keywords:['恒生科技','港股','互联网','科技']},
        {ts_code:'010213.OF',name:'中欧互联网先锋混合A',type:'混合型',amount:4090.43,keywords:['互联网','科技','中概股']},
        {ts_code:'000527.OF',name:'南方新优享灵活配置混合A',type:'混合型',amount:31525.10,keywords:['A股','混合基金']},
        {ts_code:'160630.OF',name:'鹏华中证国防指数(LOF)A',type:'股票型',amount:10499.73,keywords:['国防','军工','航天']},
        {ts_code:'006321.OF',name:'中欧预见养老2035三年持有(FOF)A',type:'混合型',amount:6143.34,keywords:['养老','FOF']},
        {ts_code:'165513.OF',name:'中信保诚全球商品主题(QDII-FOF)A',type:'混合型',amount:20990.14,keywords:['商品','黄金','原油','大宗商品']},
        {ts_code:'012323.OF',name:'华宝中证医疗ETF联接C',type:'股票型',amount:7144.95,keywords:['医疗','医药','CRO','医疗器械']},
        {ts_code:'021855.OF',name:'博时中证油气资源ETF联接A',type:'股票型',amount:25896.62,keywords:['油气','石油','天然气','能源']},
        {ts_code:'005918.OF',name:'天弘沪深300ETF联接C',type:'股票型',amount:5630.85,keywords:['沪深300','大盘','蓝筹']},
        {ts_code:'090010.OF',name:'大成中证红利指数A',type:'股票型',amount:31780.87,keywords:['红利','高股息','价值投资']},
        {ts_code:'168002.OF',name:'国寿安保策略精选混合A',type:'混合型',amount:3392.93,keywords:['A股','策略精选']},
        {ts_code:'016243.OF',name:'广发成长领航一年持有期混合A',type:'混合型',amount:6839.43,keywords:['成长','广发']},
        {ts_code:'217022.OF',name:'招商产业债券A',type:'债券型',amount:1549.54,keywords:['债券','产业债','信用债']},
        {ts_code:'009345.OF',name:'中银顺兴回报一年持有期混合A',type:'混合型',amount:0.95,keywords:['中银','混合基金']},
        {ts_code:'004237.OF',name:'中欧新蓝筹灵活配置混合C',type:'混合型',amount:6930.25,keywords:['蓝筹','中欧','A股']},
        {ts_code:'160424.OF',name:'华安创业板50ETF联接C',type:'股票型',amount:21357.48,keywords:['创业板','成长股','科技']},
        {ts_code:'007119.OF',name:'睿远成长价值混合A',type:'混合型',amount:9724.56,keywords:['成长价值','睿远']},
        {ts_code:'501057.OF',name:'汇添富中证新能源汽车产业指数(LOF)A',type:'股票型',amount:6848.10,keywords:['新能源汽车','电动车','锂电池']},
        {ts_code:'011435.OF',name:'中欧研究精选混合A',type:'混合型',amount:10898.06,keywords:['研究精选','中欧','A股']},
        {ts_code:'012608.OF',name:'信澳领先智选混合',type:'混合型',amount:20740.83,keywords:['信澳','领先智选']},
        {ts_code:'161604.OF',name:'融通深证100指数A/B',type:'股票型',amount:18165.22,keywords:['深证100','深市','大盘指数']},
        {ts_code:'012733.OF',name:'易方达中证人工智能主题ETF联接A',type:'股票型',amount:7892.37,keywords:['人工智能','AI','算力','大模型']},
        {ts_code:'012953.OF',name:'华泰柏瑞恒利混合A',type:'混合型',amount:76564.97,keywords:['华泰柏瑞','混合基金']},
        {ts_code:'006291.OF',name:'南方养老2035(FOF)C',type:'混合型',amount:7254.19,keywords:['养老','FOF','南方']},
        {ts_code:'022425.OF',name:'广发中证A500ETF联接C',type:'股票型',amount:85232.61,keywords:['A500','大盘','指数']},
        {ts_code:'011823.OF',name:'易方达产业升级混合C',type:'混合型',amount:17027.66,keywords:['产业升级','易方达','制造业']},
        {ts_code:'012650.OF',name:'博时半导体主题混合A',type:'混合型',amount:21392.81,keywords:['半导体','芯片','国产替代']},
        {ts_code:'011665.OF',name:'汇添富数字经济引领发展三年持有混合A(份额1)',type:'混合型',amount:25263.32,keywords:['数字经济','数字技术','云计算']},
        {ts_code:'011665.OF',name:'汇添富数字经济引领发展三年持有混合A(份额2)',type:'混合型',amount:18939.00,keywords:['数字经济','数字技术','云计算']},
        {ts_code:'000171.OF',name:'易方达裕丰回报债券A',type:'债券型',amount:70025.84,keywords:['债券','裕丰','信用债']},
        {ts_code:'005919.OF',name:'天弘中证500ETF联接C',type:'股票型',amount:20753.36,keywords:['中证500','中小盘','指数']},
        {ts_code:'001694.OF',name:'创金合信量化发现灵活配置混合',type:'混合型',amount:53550.13,keywords:['量化','多因子','A股']},
        {ts_code:'015949.OF',name:'宝盈中证A100指数增强A',type:'股票型',amount:7512.07,keywords:['A100','指数增强','大盘']},
        {ts_code:'014985.OF',name:'华安创业板50指数C',type:'股票型',amount:11284.98,keywords:['创业板','成长股','科技']}
    ];
    defaults.forEach(f => DataManager.addFund(f));
    DataManager.save();
}

document.addEventListener('DOMContentLoaded', () => { initDefaultFunds(); App.init(); });
