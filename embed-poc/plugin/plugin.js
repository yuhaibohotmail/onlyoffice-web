/**
 * PoC 配置探针插件。**只干一件事：把编辑器下发的 options 显示出来、并报出去。**
 *
 * ── 为什么值得单独有这么一个插件 ────────────────────────────────────────
 *
 * 插件有两条互不相干的通道：
 *
 *   通道一：静态登记表（静态根下那份 plugins.json）——装的是镜像自带那 11 个官方插件，
 *           **它给不了配置**，没有 options 这一格。
 *   通道二：编辑器配置里的 `editorConfig.plugins`（pluginsData / autostart / **options**）
 *           ——`options` 是**宿主给插件下发配置的唯一通道**，
 *           真实部署里放的正是插件访问它自己后端要用的凭证。
 *
 * 通道二是接真后端时唯一要紧的那条，而**光看代码看不出它通不通**。
 * 这个插件就是那条通道的收货人：它收到什么，就证明什么真的送到了。
 */

(function () {
  var 收到的框 = document.getElementById("收到的");
  var 状态框 = document.getElementById("状态");

  function 说(s) {
    状态框.textContent = s;
  }

  /**
   * 把消息发给**最顶层窗口**。
   *
   * ⚠ **不是 window.parent。** 插件 iframe 的 parent 是**编辑器 iframe**，
   * 发给 parent 的话最外面那个页面永远收不到，
   * 而插件本身一切正常——一个不报错的断链。
   */
  function 报出去(消息) {
    try {
      if (window.top) window.top.postMessage(消息, "*");
      if (window.parent && window.parent !== window.top) {
        window.parent.postMessage(消息, "*");
      }
    } catch (e) {
      // 跨源拿不到 top 的情况下别让它把插件带崩。
    }
  }

  if (!window.Asc || !window.Asc.plugin) {
    说("引导脚本没加载上（plugins.js 取不到？）——插件 API 不存在。");
    报出去({ __pocPlugin: "boot-failed" });
    return;
  }

  /**
   * ⚠ **一个事件名只能挂一个处理函数**，后挂的会覆盖前面的，而且不报错。
   * 所以这里 init 只写这一处。
   */
  window.Asc.plugin.init = function () {
    var info = (window.Asc.plugin && window.Asc.plugin.info) || {};
    var options = info.options || {};
    var 有没有 = Object.keys(options).length > 0;

    收到的框.textContent = "options：" + JSON.stringify(options, null, 2);
    说(有没有 ? "收到配置了。" : "初始化完了，但 options 是空的。");

    // 报给最外面那个页面，实测据此断言「宿主放进去的那几格，插件真的收到了」。
    报出去({
      __pocPlugin: "ready",
      有没有收到options: 有没有,
      options: options,
    });
  };

  说("引导脚本在，等编辑器发 init…");
})();
