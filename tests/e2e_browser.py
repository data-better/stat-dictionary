"""브라우저 동작 점검 (선택). 필요: pip install playwright && playwright install chromium
먼저 다른 터미널에서  python -m http.server 8765 -d web  을 실행한 뒤  python tests/e2e_browser.py
화면 캡처는 /tmp/s1.png ~ s5.png 에 저장된다.
"""
import asyncio, json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width":1100,"height":900}, accept_downloads=True)
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
        await pg.route("**/fonts.googleapis.com/**", lambda r: r.abort())
        await pg.route("**/cdn.jsdelivr.net/**", lambda r: r.abort())
        await pg.goto("http://localhost:8765/")
        await pg.wait_for_function("document.querySelector('#status').textContent.includes('표제어')")
        print("status:", await pg.text_content("#status"))
        async def q(s):
            await pg.fill("#q", s); await pg.wait_for_timeout(300)
            return await pg.text_content("#status"), await pg.eval_on_selector_all(".entry .headword", "els=>els.slice(0,3).map(e=>e.innerText)")
        for s in ["likelihood ratio test","우도비 검증","power","REML","ㄱㅈㄱㅅ","Levy process","gauss jordan","likelihod ratio"]:
            print(s, "=>", await q(s))
        print("empty:", await pg.inner_text("#results"))
        await q("likelihood ratio test"); print(await pg.inner_text(".entry >> nth=0"))
        await pg.screenshot(path="/tmp/s1.png", full_page=False)
        # browse
        await pg.fill("#q",""); await pg.click("[data-index=ko]"); await pg.click("[data-letter=ㄷ]"); await pg.wait_for_timeout(200)
        print("browse:", await pg.text_content("#status"))
        await pg.screenshot(path="/tmp/s2.png")
        # edit mode: add
        await pg.check("#edit-toggle")
        await pg.click("[data-action=new]")
        await pg.fill("#f-ko","등각예측, 컨포멀 예측(법)")
        await pg.fill("#f-en","conformal prediction (CP)")
        await pg.wait_for_timeout(100)
        print("form err:", await pg.text_content("#form-error"), await pg.is_disabled("#form-save"))
        await pg.select_option("select[data-paren='0']","optional")
        print("preview:", await pg.inner_text("#preview"), "| err:", await pg.text_content("#form-error"))
        await pg.fill("#f-reason","신규"); await pg.fill("#f-editor","DataBetter")
        await pg.screenshot(path="/tmp/s3.png")
        await pg.click("#form-save"); await pg.wait_for_timeout(300)
        print("after add:", await q("conformal"), await q("컨포멀"))
        # update r0003
        await pg.fill("#q","likelihood"); await pg.wait_for_timeout(300)
        await pg.click(".entry >> nth=0 >> [data-action=edit]")
        await pg.wait_for_timeout(200); print("no change err:", await pg.text_content("#form-error"), await pg.is_disabled("#form-save"))
        await pg.fill("#f-ko","가능도, 라이클리후드")
        await pg.click("#form-save"); await pg.wait_for_timeout(300)
        print("우도:", await q("우도"))
        print("라이클리후드:", await q("라이클리후드"))
        # delete u0001 then undo, then delete again
        await q("conformal prediction")
        await pg.click(".entry >> nth=0 >> [data-action=delete]")
        await pg.fill("#d-reason","테스트 삭제"); await pg.click("#delete-form button[type=submit]"); await pg.wait_for_timeout(300)
        print("after delete:", await q("conformal prediction"))
        await pg.click("[data-action=deleted]"); await pg.wait_for_timeout(100)
        print("deleted list:", await pg.inner_text("#list-body"))
        await pg.click("#list-body [data-action=restore]"); await pg.wait_for_timeout(300)
        await pg.click("#list-dialog [data-close]")
        print("after restore:", await q("conformal prediction"))
        # duplicate warning
        await pg.click("[data-action=new]")
        await pg.fill("#f-ko","조기종료"); await pg.fill("#f-en","early termination"); await pg.wait_for_timeout(100)
        print("dup:", await pg.inner_text("#preview"))
        await pg.fill("#f-ko","가[나"); await pg.wait_for_timeout(100)
        print("bad:", await pg.text_content("#form-error"))
        await pg.click("#form-dialog [data-close]")
        # changes + export
        await pg.click("[data-action=changes]"); await pg.wait_for_timeout(100)
        await pg.screenshot(path="/tmp/s4.png")
        async with pg.expect_download() as dl:
            await pg.click("#list-body [data-action=export]")
        d = await dl.value; path = await d.path()
        data = json.load(open(path)); print("exported", len(data["edits"]), [e["op"] for e in data["edits"]])
        json.dump(data, open("/tmp/exported.json","w"), ensure_ascii=False)
        # reload persistence
        await pg.reload(); await pg.wait_for_timeout(800)
        print("after reload:", await q("라이클리후드"), await pg.text_content("#edit-summary"))
        await pg.set_viewport_size({"width":375,"height":800}); await pg.fill("#q","likelihood ratio"); await pg.wait_for_timeout(300)
        await pg.screenshot(path="/tmp/s5.png")
        print("errors:", errs)
        await b.close()
asyncio.run(main())
