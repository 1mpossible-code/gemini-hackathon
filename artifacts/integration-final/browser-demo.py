import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path('/tmp/forge-routing-final')
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    start = time.perf_counter()
    page.goto('http://127.0.0.1:5188')
    page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='System', exact=True).wait_for()
    page.locator('canvas').wait_for()
    page.wait_for_timeout(2500)
    ready_ms = round((time.perf_counter() - start) * 1000)
    page.screenshot(path=str(out / 'system.png'))
    page.get_by_role('button', name='Repair demo', exact=True).click()
    page.get_by_role('complementary', name='Board inspector').get_by_role('button', name='Check', exact=True).click()
    page.get_by_role('complementary', name='Board inspector').get_by_role('button', name='Fix with AI', exact=True).wait_for(timeout=30000)
    page.screenshot(path=str(out / 'demo-before.png'))
    page.get_by_role('complementary', name='Board inspector').get_by_role('button', name='Fix with AI', exact=True).click()
    page.get_by_text('Design checks passed (15/15 rules verified).', exact=True).wait_for(timeout=45000)
    expect(page.get_by_role('banner')).to_contain_text('Design checks passed')
    expect(page.get_by_role('contentinfo')).to_contain_text('Checks passed')
    page.wait_for_timeout(1000)
    page.screenshot(path=str(out / 'demo-passed.png'))
    assert not errors, errors
    page.get_by_role('banner').get_by_role('button', name='Undo', exact=True).click()
    page.get_by_role('complementary', name='Board inspector').get_by_role('button', name='Fix with AI', exact=True).wait_for()
    page.get_by_role('button', name='Full rover PCB', exact=True).click()
    page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='System', exact=True).click()
    page.get_by_text('6 issues need review', exact=True).wait_for()
    page.screenshot(path=str(out / 'rover-final.png'))
    assert not errors, errors
    print('PASS real demo repair 15/15, header/footer statuses, repair Undo, full-rover restoration; zero page errors')
    browser.close()
