import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(__file__).parent
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    start = time.perf_counter()
    page.goto('http://127.0.0.1:5175')
    page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='System', exact=True).wait_for()
    page.locator('canvas').wait_for()
    page.wait_for_timeout(2500)
    ready_ms = round((time.perf_counter() - start) * 1000)
    page.screenshot(path=str(out / 'system.png'))
    page.get_by_role('button').filter(has_text='Front-left motor').first.click()
    page.get_by_text('Replacement options', exact=True).wait_for()
    assert page.locator('.forge-tag').count() > 0
    page.screenshot(path=str(out / 'replacement.png'))
    page.get_by_role('button', name='Component labels: Focus', exact=True).click()
    timings = []
    for i in range(8):
        start = time.perf_counter()
        page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='Board' if i % 2 == 0 else 'System', exact=True).click()
        expect(page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='Board' if i % 2 == 0 else 'System', exact=True)).to_have_attribute('aria-selected', 'true', timeout=15000)
        page.wait_for_timeout(850)
        assert page.locator('canvas').count() == 1
        timings.append(round((time.perf_counter() - start) * 1000))
    page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='Board', exact=True).click()
    expect(page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='Board', exact=True)).to_have_attribute('aria-selected', 'true', timeout=15000)
    page.wait_for_timeout(1000)
    page.screenshot(path=str(out / 'board.png'))
    page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='System', exact=True).click()
    expect(page.get_by_role('tablist', name='Workspace view').get_by_role('tab', name='System', exact=True)).to_have_attribute('aria-selected', 'true', timeout=15000)
    page.wait_for_timeout(1000)
    page.get_by_role('tab', name='Parts & cost').click()
    page.get_by_role('spinbutton', name='Budget in dollars').fill('20')
    page.wait_for_timeout(500)
    page.get_by_text('Over budget by $10.00', exact=True).wait_for()
    page.get_by_text('$10.00 over budget', exact=True).wait_for()
    page.screenshot(path=str(out / 'cost.png'))
    page.get_by_role('button').filter(has_text='Front-left motor').first.click()
    page.get_by_role('button', name='Replace all 4 (+$23.60)', exact=True).click()
    page.get_by_role('button', name='Undo', exact=True).first.wait_for()
    page.screenshot(path=str(out / 'replaced.png'))
    page.get_by_role('button', name='Undo', exact=True).first.click()
    page.get_by_text('TT gear motor 1:48', exact=True).first.wait_for()
    page.get_by_role('button').filter(has_text='Front-left motor').first.click()
    page.get_by_text('Technical details', exact=True).first.click()
    page.screenshot(path=str(out / 'technical-details.png'))
    frames = page.evaluate('''() => new Promise(resolve => {
      const times = []; let last = performance.now();
      function frame(now) { times.push(now-last); last=now;
        if (times.length < 120) requestAnimationFrame(frame); else resolve(times.slice(1)); }
      requestAnimationFrame(frame);
    })''')
    result = {'ready_ms_including_2500ms_settle': ready_ms, 'transition_ms_including_850ms_wait': timings,
              'raf_mean_ms': round(sum(frames)/len(frames), 2), 'raf_p95_ms': round(sorted(frames)[int(len(frames)*.95)], 2),
              'page_errors': errors}
    (out / 'results.json').write_text(json.dumps(result, indent=2))
    assert not errors, errors
    browser.close()
