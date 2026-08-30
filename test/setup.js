// 按帧合并渲染引入了 requestAnimationFrame。jsdom 的 rAF 是异步的,
// 会让同步断言的测试在 emit 后看不到渲染结果 —— 这里把它改成同步,
// 让"触发 → 渲染"在同一 tick 完成。真实浏览器行为不变。
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};
