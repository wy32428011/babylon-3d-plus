from playwright.sync_api import sync_playwright, expect

VIEWPORTS = [
    {"name": "desktop", "width": 1365, "height": 768},
    {"name": "minimum", "width": 1024, "height": 640},
]


def collect_layout(page):
    return page.evaluate(
        """
        () => {
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const rectOf = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              scrollWidth: element.scrollWidth,
              scrollHeight: element.scrollHeight,
              clientWidth: element.clientWidth,
              clientHeight: element.clientHeight,
            };
          };
          const panelByHeading = (heading) => {
            const title = Array.from(document.querySelectorAll('h2')).find((node) => node.textContent?.trim() === heading);
            const element = title?.closest('.panel, .scene-panel');
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              scrollWidth: element.scrollWidth,
              scrollHeight: element.scrollHeight,
              clientWidth: element.clientWidth,
              clientHeight: element.clientHeight,
            };
          };
          return {
            viewport,
            body: {
              scrollWidth: document.body.scrollWidth,
              scrollHeight: document.body.scrollHeight,
              clientWidth: document.body.clientWidth,
              clientHeight: document.body.clientHeight,
            },
            toolbar: rectOf('.toolbar'),
            hierarchy: panelByHeading('Hierarchy'),
            scene: panelByHeading('Scene'),
            inspector: panelByHeading('Inspector'),
            console: panelByHeading('Console'),
            project: rectOf('.project-library'),
            projectTabs: rectOf('.project-library .library-tabs'),
            projectCards: rectOf('.project-library .resource-card-list'),
            sceneCanvas: rectOf('.scene-canvas'),
          };
        }
        """
    )


def assert_rect_visible(name, rect, viewport):
    assert rect is not None, f"{name} 不存在"
    assert rect["width"] > 0 and rect["height"] > 0, f"{name} 尺寸无效：{rect}"
    assert rect["left"] >= -1, f"{name} 左侧越界：{rect}"
    assert rect["top"] >= -1, f"{name} 顶部越界：{rect}"
    assert rect["right"] <= viewport["width"] + 1, f"{name} 右侧越界：{rect} / {viewport}"
    assert rect["bottom"] <= viewport["height"] + 1, f"{name} 底部越界：{rect} / {viewport}"


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    for viewport in VIEWPORTS:
        page.set_viewport_size({"width": viewport["width"], "height": viewport["height"]})
        page.goto('http://127.0.0.1:5173')
        page.wait_for_load_state('networkidle')
        expect(page.locator('h2', has_text='Scene')).to_be_visible()

        layout = collect_layout(page)
        for name in ['toolbar', 'hierarchy', 'scene', 'inspector', 'console', 'project', 'projectTabs', 'projectCards', 'sceneCanvas']:
            assert_rect_visible(f"{viewport['name']}:{name}", layout[name], layout['viewport'])

        assert layout['scene']['width'] >= 360, f"{viewport['name']}: Scene 宽度不足：{layout['scene']}"
        assert layout['project']['height'] >= 170, f"{viewport['name']}: Project 高度不足：{layout['project']}"
        assert layout['toolbar']['scrollWidth'] >= layout['toolbar']['clientWidth'], f"{viewport['name']}: Toolbar 滚动指标异常"
        assert layout['projectTabs']['scrollWidth'] >= layout['projectTabs']['clientWidth'], f"{viewport['name']}: Project 页签滚动指标异常"
        assert layout['projectCards']['scrollWidth'] >= layout['projectCards']['clientWidth'], f"{viewport['name']}: Project 卡片滚动指标异常"

        print(f"{viewport['name']} {viewport['width']}x{viewport['height']} PASS")
        print({
            'scene': {'width': round(layout['scene']['width']), 'height': round(layout['scene']['height'])},
            'project': {'width': round(layout['project']['width']), 'height': round(layout['project']['height'])},
            'toolbarScroll': [layout['toolbar']['clientWidth'], layout['toolbar']['scrollWidth']],
            'tabsScroll': [layout['projectTabs']['clientWidth'], layout['projectTabs']['scrollWidth']],
            'cardsScroll': [layout['projectCards']['clientWidth'], layout['projectCards']['scrollWidth']],
        })

    browser.close()
