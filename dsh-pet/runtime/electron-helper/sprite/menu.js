/**
 * 右键菜单：打开/关闭、叶子动作派发，以及菜单里用到的自绘节点渲染。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 菜单结构与文案来自 shared-core（两端同一份）；这里只决定点下去之后做什么。
 * @module dsh-pet/runtime/electron-helper/sprite-menu
 */
'use strict';

// 菜单首项文案随宿主形态变：桌面应用唤起主窗口，独立模式打开本机 AI 设置页，web 宿主打开站点。
const OPEN_LABEL = { desktop: '打开软件', standalone: '打开桌宠设置', web: '打开网站' };

/** 睡觉拒绝台词的气泡时长（ms）：比默认 10s 略短，它只是「被打扰了」的一句回绝。 */
const SLEEP_REFUSE_BUBBLE_MS = 8000;

Object.assign(PetSprite.prototype, {
  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    e.preventDefault();
    this.stopThrow(); // 菜单弹出前停住飞行中的宠物
    this.stopMove(); // 菜单悬停期间宠物不漫游
    const tools = [
      {
        label: OPEN_LABEL[OPEN_TARGET],
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
      // 「查看余额」无条件显示：关了 balanceEnabled 的宠物也能点，手动请求不受开关限制，点了一定给答复。
      { label: '查看余额', action: 'show-balance' },
      // 「查询天气」与余额同一类：宿主强制刷新并写 sections.env，气泡由 /state 驱动。
      { label: '查询天气', action: 'show-environment' },
      // 「待办事项」是待办面板的唯一入口（单击宠物不再弹面板），排在余额之后。
      { label: '待办事项', action: 'todo', hint: S.TODO_HOTKEY_HINT },
    ];
    // 睡觉/起来：睡着时这一项是「起来」（点它等于叫醒），醒着时是「睡觉」。两种文案共用一个位置，
    // 该条目没配 animations.sleep 就整项不出现——与配置注释「不写 = 没有睡觉功能」一致。
    if (Array.isArray(this.animations.sleep) && this.animations.sleep.length > 0) {
      if (this.sleeping) tools.push({ label: '起来', action: 'wake', hint: S.SLEEP_HOTKEY_HINT });
      else tools.push({ label: '睡觉', action: 'sleep', hint: S.SLEEP_HOTKEY_HINT });
    }
    // 独立应用的重载入口在配置页底部，其他 Helper 保留右键入口。
    const tail = [
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置，由宿主重载生效。
      // 与浏览器端注入同一份子菜单，两端文案与取值不会漂移。不就地开关窗：窗口是进程启动时按
      // DSH_PET_PETS 一次性建的，就地增删既改不了磁盘配置也改不了窗口数量。
      S.displayMenuBranch(),
      ...(CONFIG.appMode ? [] : [{ label: '重载配置', action: 'reload' }]),
      { label: '回到初始位置', action: 'home' },
    ];
    // 第三方菜单项统一收在「更多」下：label 唯一的直接平铺，label 重名的按 owner 分子菜单。
    // 放在最后——「更多」不插在工具项与动作之间。
    const more = S.buildMoreBranch(this.menuItems);
    const tree = tools.concat(S.buildMenuTree(this.animations), tail, more ? [more] : []);
    if (!tree.length) return;
    this.menuOpen = true;
    this.setInteractive(true); // 菜单是窗口内 DOM：悬停期间整窗保持可交互，关闭后恢复命中区穿透
    this.syncInputBusy();
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX,
      y: e.clientY,
      // 只允许在「窗口 ∩ 工作区」内显示：宠物贴边时外扩余量伸出屏幕，菜单走进那里会被 OS 裁掉
      clamp: this.visibleClampRect(),
      desktopLayout: { onChange: () => this.syncInputRegions() },
      onAction: (leaf) => this.onMenuAction(leaf),
      // 菜单被点外/Esc 关闭（非菜单项路径）：同样复位可交互标记，恢复命中区判定
      onClose: () => {
        this.menuOpen = false;
        window.__dshPetDebug.menuOpen = false;
        this.syncInputBusy();
        if (!this.inputBusy()) this.setInteractive(false);
      },
    });
    this.menuClose = m.close;
    this.syncInputRegions(); // mountContextMenu 完成布局后才能读取菜单矩形
  },

  /** keepFacing = 调用方已显式指定朝向：跳过下面「文字类动画点播前强制朝左」的镜像修正，显式值优先。 */
  onMenuAction(leaf, keepFacing, fromHost) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    // 睡觉：打扰类动作在点击这一刻就拒绝——弹一句台词，什么都不执行。持锁时让路（锁=控制权交给第三方）。
    // 待办面板、点播动画都是渲染端行为，宿主闸门拦不到；两端用同一份放行判定。
    if (this.sleeping && !this.frozen && !fromHost && !S.isSleepAllowedAction(leaf.action)) {
      const pool = Array.isArray(this.pet.sleepRefuseTexts) ? this.pet.sleepRefuseTexts : [];
      const text = pool[Math.floor(Math.random() * pool.length)];
      if (text !== undefined) this.showWhisper(text, undefined, undefined, SLEEP_REFUSE_BUBBLE_MS, false);
      return;
    }
    if (leaf.action === 'third-party') {
      // 第三方菜单项：只把 (owner, label) 交给宿主，具体做什么由注册方自己查 /menu/events。
      // 带上宠物 id——同一条菜单项在不同宠物上被点，注册方要能分辨是哪只。
      if (leaf.owner) {
        S.postAction(BASE + '/menu/click', { owner: leaf.owner, label: leaf.label, pet: this.pet.id }).catch(() => {
          /* 上报失败不影响本地：注册方下次轮询自然拿不到这次触发 */
        });
      }
      return;
    }
    if (leaf.action === 'open-site') {
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN); // 系统默认浏览器打开（等效 Ctrl+点击链接）
      return;
    }
    if (leaf.action === 'show-balance') {
      this.showBalanceFromMenu(); // 立即拉余额并展示（无需等 1s 触发轮询，展示路径与周期触发一致）
      return;
    }
    if (leaf.action === 'show-environment') {
      this.showEnvironmentFromMenu(); // 强制刷新并展示（绕过宿主缓存，理由见该方法注释）
      return;
    }
    if (leaf.action === 'sleep' || leaf.action === 'wake') {
      // 只发请求，画面等 sleep 叶子回来才动：三段名与时机都由宿主/渲染端状态机决定（见 setSleep）
      this.postSleepAction(leaf.action);
      return;
    }
    if (leaf.action === 'todo') {
      this.toggleTodo(); // 打开待办面板（右键菜单入口）
      return;
    }
    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }
    if (leaf.action === 'set-display') {
      this.setPetDisplay(leaf.display); // 改这只宠物的显示位置：写 display 配置，由宿主重载生效
      return;
    }
    if (leaf.action === 'reload') {
      this.reloadDesktop(); // 请宿主重启桌面 Helper：全部桌面宠物窗口按最新配置重建
      return;
    }
    if (!leaf.anim) return;
    // 回执归属：这一段若来自第三方点播，编号跟着换源走（自播动画传 null）
    const playbackId = typeof leaf.playbackId === 'string' && leaf.playbackId ? leaf.playbackId : null;
    // 文字类（noMirror）朝右是镜像的：点播前强制朝左，避免文字镜像。keepFacing 时跳过（显式值优先）。
    if (!keepFacing && S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（与随机游走同一套），只有「选哪个动画」由菜单决定；挪不动则退化纯播放。
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      const moved = this.tryMove(leaf.anim, playbackId);
      if (moved === false) this.playOnce(leaf.anim, playbackId);
      // moved === true = 已有移动/抛掷在进行中（没换源）：本段不会真的播起来 → 如实回 failed/busy
      else if (moved === true && playbackId) this.reportPlayback(playbackId, 'failed', 'busy');
      return;
    }
    this.playOnce(leaf.anim, playbackId);
  },

  closeMenu() {
    if (this.menuClose) {
      this.menuClose();
      this.menuClose = null;
    }
    this.menuOpen = false;
    window.__dshPetDebug.menuOpen = false;
    this.syncInputBusy(); // 菜单关：若没有别的占用（拖拽/弹窗）则交还常规判定
    if (!this.inputBusy()) this.setInteractive(false);
  },

  // 「查看余额」菜单：POST 动作让宿主刷新余额。结果这里什么都不用做——写叶子会让版本号变，
  // 挂着的长轮询那一拍立刻返回并展示（同一展示路径）。数据只有一个出口（S），菜单只负责让它刷新。
  // 不做 balanceEnabled 门控：手动请求不受开关限制，关了余额的宠物被点一次也该看到数据。
  // 带 pet：这次只让被点的那只弹（宿主写进叶子的归属）；surface=desktop = 本窗口就是桌面端。
  showBalanceFromMenu() {
    S.postAction(BALANCE_URL + '?pet=' + encodeURIComponent(this.pet.id) + '&surface=desktop')
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单查看余额：刷新动作未成功');
      })
      .catch((e) => {
        console.error('[dsh-pet] 菜单查看余额异常', e);
      });
  },

  // 「查询天气」菜单：与余额同一条路——POST 动作让宿主强制刷新并写 sections.env，
  // 本端什么都不用做，叶子变了由轮询分发到 showEnvNow。fresh=1 是用户点这个按钮的唯一意义：
  // 平时对话走缓存（天气 1 小时），手动查必须拿现在的。
  showEnvironmentFromMenu() {
    S.postAction(ENVIRONMENT_URL + '?pet=' + encodeURIComponent(this.pet.id) + '&surface=desktop&fresh=1')
      .then((ok) => {
        if (!ok) console.warn('[dsh-pet] 菜单查询天气：刷新动作未成功 pet=' + this.pet.id);
      })
      .catch((e) => {
        console.error('[dsh-pet] 菜单查询天气异常', e);
      });
  },

  // 待办面板开关：面板占气泡槽（优先级最高），期间整窗保持可交互，关闭后交还命中区穿透。
  // 与浏览器半侧共用 shared/todo/panel，只有接口基址不同（桌面是 file:// 页面，必须绝对地址）。
  toggleTodo() {
    if (this.todoPanel) {
      this.closeTodo();
      return;
    }
    const panel = S.createTodoPanel({
      baseUrl: BASE + '/todos',
      onClose: () => this.closeTodo(),
      // 点宠物本体不收起：拖它走是常见需求，收起就没法一边看清单一边挪位置。
      keepOpenOn: (target) => typeof target?.closest === 'function' && target.closest('.pet-hit') !== null,
    });
    // replaceChildren 而不是 appendChild：气泡里还留着上一次渲染的行（碎碎念/余额），
    // 而 renderBubble 在面板开着时会提前返回、走不到清空那一步，不清就会叠在面板上方。
    this.bubble.replaceChildren(panel.el);
    this.todoPanel = panel;
    this.todoOpen = true;
    window.__dshPetDebug.todoOpen = true;
    this.renderBubble();
    this.syncInputBusy();
    this.setInteractive(true);
  },

  // 收起待办面板：摘掉面板节点、撤掉气泡变体类，再把槽位交回正常判定。
  closeTodo() {
    const panel = this.todoPanel;
    if (!panel) return;
    panel.dispose();
    this.todoPanel = null;
    this.todoOpen = false;
    window.__dshPetDebug.todoOpen = false;
    this.renderBubble();
    this.syncInputBusy();
    if (!this.menuOpen) this.setInteractive(false);
  },

  // 「回到初始位置」菜单：停掉漫游/移动，清掉会话位置，回到配置角落
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.position();
  },

  // 「重载配置」菜单：请宿主重启桌面 Helper，与设置页「保存」同一条重启路径（宿主 POST /reload →
  // syncDesktop）。不在渲染端就地重拉：窗口数量/display/size 由宿主按 DSH_PET_PETS 建，且全局轮询是
  // 一次性启动的（loopsStarted），就地重建会漏启新循环或留下旧定时器。
  // 本请求由即将被重启的进程发出，响应可能永远不回（宿主杀进程时回调地址已失效），故不 await、
  // 不重试，失败只记日志——重载本身就是把本进程换掉。
  reloadDesktop() {
    fetch(BASE + '/reload', { method: 'POST' }).catch((e) => {
      console.warn('[dsh-pet] 重载配置请求失败（宿主不可达？）', e);
    });
  },

  // 「显示位置」菜单：改这一只宠物的 display，写它自己的配置，再由宿主重载生效。取值直接来自菜单项，
  // 渲染端不做推导（当前状态以配置为准）。不就地开关窗：窗口是进程启动时按 DSH_PET_PETS 一次性建的。
  // 与 reloadDesktop 同一处境：选「仅网页/都不」时本进程会在重载中被换掉，故不 await、不重试。
  setPetDisplay(display) {
    if (!display) return;
    fetch(BASE + '/pet-display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.pet.id, display }),
    }).catch((e) => {
      console.warn('[dsh-pet] 显示位置请求失败（宿主不可达？）', e);
    });
  },

  /**
   * 自定义节点树 → DOM（custom 形态的渲染器）。
   *
   * tag 与样式白名单在 shared 的解析层已裁过，这里只做映射：不用 innerHTML，文本走 createTextNode，
   * 第三方内容因而没有注入面。样式键是 camelCase，直接赋给 el.style 即可。
   */
  renderTree(node) {
    const el = document.createElement(node.tag);
    if (node.style) {
      for (const [key, value] of Object.entries(node.style)) el.style[key] = value;
    }
    if (node.tag === 'img') {
      el.src = node.src || '';
      el.alt = '';
      return el;
    }
    // 文本与子节点可同时存在：先文本、后子节点（与 textContent + appendChild 的顺序一致）
    if (node.text) el.appendChild(document.createTextNode(node.text));
    for (const child of node.children || []) el.appendChild(this.renderTree(child));
    return el;
  },
});
