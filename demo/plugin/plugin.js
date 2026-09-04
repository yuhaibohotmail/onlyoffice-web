/**
 * 公式实验室——本项目自己写的 OnlyOffice 插件。
 *
 * 它存在只为回答一个问题：**在这套「纯前端 OnlyOffice」里，插件到底能不能干活。**
 * 所以它做的四件事都挑了会留下痕迹的：每一件的判据都是**导出的 docx 字节里能不能找到**，
 * 而不是面板上显示了什么。面板上写「成功」是最不值钱的一种证据——
 * 上一轮就吃过一次「接口报 ready 而页面是白的」。
 *
 *   ① 插公式        PasteHtml 一段 MathML   → document.xml 里出现 <m:oMath>
 *   ② 文档内按钮    内容控件 + 挂在它上的按钮 → 点一下，文档里多一段字
 *   ③ 配置下发通道  读 Asc.plugin.info.options → 把收到的值写进文档
 *
 * 三条已知会咬人的地方，都在下面对应的注释里写了为什么这么写。
 */
(function (window) {
  "use strict";

  var statusEl = null;
  var optionsEl = null;

  var CC_TAG = "poclab-q";
  var CLICK_MARK = "CCBUTTONCLICKED-3F9K";

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "";
  }

  /**
   * executeMethod 的 promise 版，**而且是排一队串行发的**。
   *
   * 编辑器一次只认一个 executeMethod；更要紧的是连着发两个 PasteHtml 会把它打死
   * （粘贴是异步的，回调回来时字体还在加载，这时候发下一个就炸），
   * 之后整篇文档报「使用文档时出错」——**一个把自己伪装成「文档坏了」的调用序列错误**。
   * 所以这里排队，且给每个调用一个超时：不给的话，编辑器不回调就是永远挂着，
   * 而面板上什么都不显示，看着像按钮没绑上。
   */
  var queue = Promise.resolve();
  function callMethod(name, args, timeoutMs) {
    var limit = timeoutMs || 20000;
    queue = queue.then(function () {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new Error(name + " 超时（" + limit + "ms 没回调）"));
        }, limit);
        try {
          window.Asc.plugin.executeMethod(name, args || [], function (result) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
          });
        } catch (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        }
      });
    });
    return queue;
  }

  // ── ① 公式 ────────────────────────────────────────────────────────────

  /** 一元二次方程求根公式。分式 + 根号 + 上标，够覆盖常见结构。 */
  function quadraticMathML() {
    return '<math xmlns="http://www.w3.org/1998/Math/MathML">'
      + '<mi>x</mi><mo>=</mo>'
      + '<mfrac>'
      +   '<mrow>'
      +     '<mo>&#x2212;</mo><mi>b</mi><mo>&#xB1;</mo>'
      +     '<msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup>'
      +       '<mo>&#x2212;</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt>'
      +   '</mrow>'
      +   '<mrow><mn>2</mn><mi>a</mi></mrow>'
      + '</mfrac>'
      + '</math>';
  }

  /**
   * 定积分。**这里有一个已知的坑，故意保留并就地修掉，好让报告能说清楚它。**
   *
   * 编辑器把 ∫ 外面那层 msubsup 转成 OMML 的 n 元运算符（三个槽：下限、上限、
   * **被积式**），但它**不会**把后面那个兄弟节点吸进第三个槽，于是被积式那一格
   * 画成一个空框——看着像公式渲染坏了，其实是转换规则的边界。
   * 修法：插入之前把后面那个 <mrow> 搬进 msubsup 里当第四个孩子。
   * 下面直接写成搬好的样子，并在这里说明它为什么长这样。
   */
  function integralMathML() {
    return '<math xmlns="http://www.w3.org/1998/Math/MathML">'
      + '<msubsup>'
      +   '<mo>&#x222B;</mo>'
      +   '<mn>0</mn>'
      +   '<mn>1</mn>'
      // ↓ 第四个孩子＝被积式。放在这里而不是 msubsup 后面，n 元运算符那一格才不是空的。
      +   '<mrow><msup><mi>x</mi><mn>2</mn></msup>'
      +     '<mi>d</mi><mi>x</mi></mrow>'
      + '</msubsup>'
      + '<mo>=</mo><mfrac><mn>1</mn><mn>3</mn></mfrac>'
      + '</math>';
  }

  function insertFormula(which) {
    var mathml = which === "nary" ? integralMathML() : quadraticMathML();
    var label = which === "nary" ? "定积分" : "求根公式";
    setStatus("正在插入" + label + "…");
    return callMethod("PasteHtml", ["<p>" + label + "：" + mathml + "</p>"])
      .then(function () { setStatus(label + " 已插入。导出后应能在 document.xml 里找到 <m:oMath>"); })
      .catch(function (e) { setStatus("插入失败：" + e.message, true); });
  }

  // ── ② 文档内按钮 ──────────────────────────────────────────────────────

  /**
   * 内容控件按钮的图标表。**`icons` 是必填的**——不给的话编辑器内部抛错，
   * 而外面显示的是「使用文档时出错」，看着像文档坏了，没人会顺着查到这里。
   *
   * 五档缩放各要一项：只登记 100% 的话，浏览器缩放到 125% 那档会去要一个
   * 不存在的地址，得到 404。图就那两张，100% 用一倍图、其余用二倍图缩下来。
   * 最外层是「一套主题一项」，我们只有一套。
   */
  function buttonIcons() {
    var table = {};
    ["100%", "125%", "150%", "175%", "200%"].forEach(function (scale) {
      var url = scale === "100%" ? "resources/icon.png" : "resources/icon@2x.png";
      table[scale] = { normal: url, hover: url, active: url };
    });
    return [table];
  }

  /** 插一段题干，然后把它包成一个带 Tag 的内容控件——按钮认的就是这个 Tag。 */
  function insertQuestion() {
    setStatus("正在插入题目…");
    var html = "<p>【例题】已知 a=1, b=-3, c=2，求方程的根。答：____</p>";
    return callMethod("PasteHtml", [html])
      .then(function () {
        // 1 = block 级内容控件。Tag 是我们自己认的记号，Alias 是给人看的名字。
        return callMethod("AddContentControl", [1, { Tag: CC_TAG + "1", Alias: "例题1" }]);
      })
      // 插完立刻把本地表刷上，否则光标第一次进去时 checker 查不到、按钮要等下一轮
      .then(refreshContentControls)
      .then(function () {
        setStatus("题目已插入。把光标移进去，那一块左上角应出现一个「判分」按钮");
      })
      .catch(function (e) { setStatus("插入题目失败：" + e.message, true); });
  }

  /**
   * internalId → Tag 的本地表。
   *
   * ⚠ **这张表存在的理由不是「快」，是「checker 不许发请求」——这是本轮踩到的一个坑，
   * 而且它完全不报错。** 官方那套内容控件按钮是这么工作的：编辑器发
   * onShowContentControlTrack → 引导脚本挨个问每个按钮的 checker「这个控件归你管吗」
   * → 等所有 checker 的 promise 都 resolve 之后，**紧接着**发一个
   * executeMethod("AddContentControlButtons") 把按钮画上去。
   *
   * 而编辑器**一次只认一个 executeMethod**。如果 checker 自己也发一个
   * （比如去问 GetAllContentControls），那么 checker 的 promise 正是在那个调用的回调里
   * resolve 的——引导脚本随后发出的 AddContentControlButtons 就撞在同一个窗口上，
   * **被静默丢掉**。表现是：控件建出来了、事件也发了、checker 也回 true，
   * **就是按钮不出现，一句报错都没有**。
   *
   * 所以 checker 必须是**纯本地查表、当场返回**。表由我们自己在插入之后刷新，
   * 以及内容控件变化时刷新。
   */
  var ccTags = {};
  var ccRefreshPending = null;

  /**
   * 全量刷一次表。**只当兜底**——真正让表跟得上的是下面那两个事件。
   *
   * ⚠ 早先这里写成「正在刷就直接返回当前这张表」，结果是**表永远停在打开文档那一刻**：
   * 文件里本来就带的那些内容控件（上一次存进去的）根本没进表，而新插的那个进了。
   * 于是光标落在文件里带的那一块上时，checker 查不到 → 按钮不出现，
   * **看着就像「按钮功能坏了」，其实是表少了一半**。
   */
  function refreshContentControls() {
    if (ccRefreshPending) return ccRefreshPending;
    ccRefreshPending = callMethod("GetAllContentControls", [], 8000).then(function (list) {
      var map = {};
      (list || []).forEach(function (c) { map[c.InternalId] = c.Tag; });
      ccTags = map;
      ccRefreshPending = null;
      return map;
    }, function () {
      ccRefreshPending = null;
      return ccTags;
    });
    return ccRefreshPending;
  }

  /** 编辑器给的事件里就带着 Tag 与 InternalId，直接记下来——比事后去查快，也不占调用窗口。 */
  function noteContentControl(e) {
    if (e && e.InternalId != null && typeof e.Tag === "string") ccTags[e.InternalId] = e.Tag;
  }

  /** 同步查表；查不到就在后台补一次，下一次事件就有了。 */
  function tagOfSync(internalId) {
    if (Object.prototype.hasOwnProperty.call(ccTags, internalId)) return ccTags[internalId];
    refreshContentControls();
    return undefined;
  }

  /** 点了文档里那个按钮之后干的事：往文档里留一段字，好让导出的字节能证明它被点过。 */
  function onButtonClick() {
    setStatus("按钮被点了，正在往文档里写结果…");
    callMethod("PasteHtml", ["<p>判分结果：" + CLICK_MARK + "</p>"])
      .then(function () { setStatus("按钮生效，结果已写进文档"); })
      .catch(function (e) { setStatus("按钮回调里出错：" + e.message, true); });
  }

  // ── ③ 配置下发通道 ────────────────────────────────────────────────────

  /**
   * 编辑器下发给本插件的那格配置。
   *
   * 它只能经 `editorConfig.plugins.options` 下来——**登记表（plugins.json）那条路
   * 没有这一格**。所以这个读数同时回答了两件事：插件跑起来了没有、
   * 以及将来接真 doc-server 时它能不能拿到访问后端要用的凭证。
   *
   * 三种形态都兜住：按 GUID 分段的、放在 all 里的、以及直接摊在顶层的。
   */
  function readOptions() {
    var info = window.Asc.plugin.info || {};
    var o = info.options || {};
    var guid = window.Asc.plugin.guid;
    var scoped = (guid && o[guid]) || {};
    var all = o.all || {};
    var merged = {};
    [all, scoped, o].forEach(function (src) {
      Object.keys(src || {}).forEach(function (k) {
        if (k !== "all" && k !== guid) merged[k] = src[k];
      });
    });
    return merged;
  }

  function showOptions() {
    var opts = readOptions();
    var text = Object.keys(opts).length ? JSON.stringify(opts) : "（编辑器没有下发 options）";
    if (optionsEl) optionsEl.textContent = "options：" + text;
    return opts;
  }

  function writeOptionsToDocument() {
    var opts = showOptions();
    if (!opts.probe) {
      setStatus("没收到 options.probe——配置下发那条通道没通", true);
      return Promise.resolve();
    }
    setStatus("正在把收到的配置写进文档…");
    return callMethod("PasteHtml", ["<p>插件收到的配置：" + opts.probe + "</p>"])
      .then(function () { setStatus("配置已写进文档：" + opts.probe); })
      .catch(function (e) { setStatus("写入失败：" + e.message, true); });
  }

  // ── 启动 ──────────────────────────────────────────────────────────────

  window.Asc.plugin.init = function () {
    statusEl = document.getElementById("status");
    optionsEl = document.getElementById("options");

    document.getElementById("btn-formula").onclick = function () { insertFormula("quadratic"); };
    document.getElementById("btn-nary").onclick = function () { insertFormula("nary"); };
    document.getElementById("btn-question").onclick = insertQuestion;
    document.getElementById("btn-options").onclick = writeOptionsToDocument;

    /*
     * 文档里那个按钮**在别的事情之前就注册**：它是挂在文档内容上的，
     * 跟这次会话读没读到配置无关。放到后面去的话，配置一出问题，
     * 已经插在文档里的那些题会连按钮都不长出来——那是两件事，不该连坐。
     */
    var btn = new window.Asc.ButtonContentControl(null, "poclab-judge");
    btn.text = "判分";
    btn.icons = buttonIcons();
    btn.addChecker(function (internalId) {
      // 只认我们自己插的那些块：按 Tag 前缀判，别的内容控件不长这个按钮。
      // ⚠ **当场返回，不许在这里发 executeMethod**，理由见 tagOfSync 上面那段。
      var tag = tagOfSync(internalId);
      return typeof tag === "string" && tag.indexOf(CC_TAG) === 0;
    });

    /*
     * 把表喂饱。两个事件都在 onShowContentControlTrack **之前**发，且各自带着
     * Tag 与 InternalId，所以 checker 跑的时候表里一定已经有这一条了。
     *
     * ⚠ **一个事件名只能挂一个处理函数**（引导脚本里是
     * `Asc.plugin["event_" + 名字] = 处理函数`，后挂的直接覆盖前面的）。
     * 所以这里只挂引导脚本没用到的那两个——去挂 onShowContentControlTrack
     * 或 onContentControlButtonClick 的话，会把按钮那套整个顶掉，而且不报错。
     */
    ["onChangeContentControl", "onFocusContentControl"].forEach(function (ev) {
      try { window.Asc.plugin.attachEditorEvent(ev, noteContentControl); }
      catch (e) { /* 没有这个事件就算了，还有全量刷新兜底 */ }
    });
    refreshContentControls();
    btn.attachOnClick(onButtonClick);

    showOptions();
    setStatus("插件已就绪。面板上四个按钮都会在文档里留下可验证的痕迹。");

    // 给外面的自动化一个明确的信号：插件真的初始化完了。
    // 不给的话，测试只能靠「面板 DOM 出现了」来判，而 DOM 出现早于 init 跑完。
    // ⚠ 发给 **window.top** 不是 window.parent：插件 iframe 的 parent 是**编辑器 iframe**，
    // 不是我们那个页面。发给 parent 的话消息落在编辑器里，页面永远收不到，
    // 而插件本身一切正常——于是「插件没起来」这个判断是错的。
    try {
      var msg = JSON.stringify({
        __pocPlugin: "ready",
        guid: window.Asc.plugin.guid,
        options: readOptions(),
      });
      if (window.top) window.top.postMessage(msg, "*");
      if (window.parent && window.parent !== window.top) window.parent.postMessage(msg, "*");
    } catch (e) { /* 跨源时拿不到，不影响插件本身 */ }
  };

  // 非模态面板通常不触发，但按约定必须定义
  window.Asc.plugin.button = function () {
    this.executeCommand("close", "");
  };
})(window);
