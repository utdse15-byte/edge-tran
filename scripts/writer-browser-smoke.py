from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
js = (ROOT / 'writer.js').read_text(encoding='utf-8')

def setup(page, kind='ce'):
    if kind=='ce':
        editor='<div id="editor" contenteditable="true" role="textbox" aria-label="Message Claude" style="width:700px;height:120px;border:1px solid"></div>'
    else:
        editor='<textarea id="editor" aria-label="Message Claude" style="width:700px;height:120px"></textarea>'
    page.set_content(f'<!doctype html><body><div style="height:500px"></div><form onsubmit="return false">{editor}<button id="send" type="button" aria-label="Send message">Send</button></form></body>')
    page.evaluate('''() => {const messages=[];const msgListeners=[];const disconnect=[];const port={postMessage(m){messages.push(structuredClone(m));},onMessage:{addListener(fn){msgListeners.push(fn)}},onDisconnect:{addListener(fn){disconnect.push(fn)}},disconnect(){for(const fn of disconnect)fn();}};window.__h={messages,msgListeners,disconnect};window.chrome={runtime:{id:'test',connect(){return port}}};}''')
    page.add_script_tag(content=js); page.wait_for_timeout(30)
    hello=page.evaluate('window.__h.messages.find(m=>m.type==="WRITER_HELLO")')
    page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'ATTACH','lease':'L'})
    page.wait_for_timeout(30)
    return hello

def send(page, msg, wait=80):
    page.evaluate('(m)=>window.__h.msgListeners[0](m)', msg)
    page.wait_for_timeout(wait)
    return page.evaluate('(id)=>window.__h.messages.findLast(m=>m.requestId===id)', msg.get('requestId'))

with sync_playwright() as p:
  b=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
  # contenteditable
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ce'); ws=hello['writerSession']
  r=send(page, {'type':'WRITE_TARGET','requestId':'nf','lease':'L','text':'a\nb','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':False})
  assert r['ok'] is False and r['code']=='focus_write_disabled'
  assert page.locator('#editor').evaluate('(e)=>e.innerHTML')==''
  r=send(page, {'type':'WRITE_TARGET','requestId':'w','lease':'L','text':'a\n\nb','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':True})
  assert r['ok'] and r['readback']=='a\n\nb' and r['targetEpoch']==1, r
  # No-focus clear leaves content untouched.
  r=send(page, {'type':'CLEAR_TARGET_IF_OWNED','requestId':'cnf','lease':'L','expectedWriterSession':ws,'expectedTargetEpoch':1,'allowFocus':False})
  assert not r['ok'] and r['code']=='focus_write_disabled', r
  st=send(page, {'type':'REQUEST_WRITER_STATE','requestId':'s1','lease':'L'})
  assert st['state']['currentText']=='a\n\nb' and st['state']['pluginOwned'] is True, st
  # Focus clear succeeds.
  r=send(page, {'type':'CLEAR_TARGET_IF_OWNED','requestId':'cf','lease':'L','expectedWriterSession':ws,'expectedTargetEpoch':1,'allowFocus':True})
  assert r['ok'] and r['targetEpoch']==2, r
  assert send(page, {'type':'REQUEST_WRITER_STATE','requestId':'sclr','lease':'L'})['state']['currentText']==''
  # Re-write and manual edit should report.
  r=send(page, {'type':'WRITE_TARGET','requestId':'w2','lease':'L','text':'plugin','expectedWriterSession':ws,'expectedTargetEpoch':2,'allowFocus':True})
  assert r['ok']; epoch=r['targetEpoch']
  page.locator('#editor').click(); page.keyboard.press('End'); page.keyboard.type(' user')
  page.wait_for_timeout(80)
  manual=page.evaluate('window.__h.messages.findLast(m=>m.type==="TARGET_MANUAL_EDIT")')
  assert manual and manual['text']=='plugin user' and manual['targetEpoch']>epoch, manual
  # Force write, then trusted send click + DOM clear without input should confirm.
  r=send(page, {'type':'WRITE_TARGET','requestId':'w3','lease':'L','text':'to send','expectedWriterSession':ws,'expectedTargetEpoch':manual['targetEpoch'],'allowFocus':True,'force':True})
  assert r['ok']; epoch=r['targetEpoch']
  page.locator('#send').click()
  page.locator('#editor').evaluate('(e)=>e.replaceChildren()')
  page.wait_for_timeout(100)
  sent=page.evaluate('window.__h.messages.findLast(m=>m.type==="SEND_CONFIRMED")')
  assert sent and sent['sentText']=='to send' and sent['targetEpoch']==epoch+1, page.evaluate('window.__h.messages')
  page.close()

  # textarea exact blank lines, no focus needed
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ta'); ws=hello['writerSession']
  r=send(page, {'type':'WRITE_TARGET','requestId':'tw','lease':'L','text':'x\n\n\ny','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':False})
  assert r['ok'] and r['readback']=='x\n\n\ny', r
  # Epoch guard blocks stale overwrite.
  page.locator('#editor').click(); page.keyboard.type('z'); page.wait_for_timeout(50)
  manual=page.evaluate('window.__h.messages.findLast(m=>m.type==="TARGET_MANUAL_EDIT")')
  stale=send(page, {'type':'WRITE_TARGET','requestId':'stale','lease':'L','text':'bad','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':False,'force':True})
  assert not stale['ok'] and stale['code']=='target_epoch_changed', stale
  assert page.locator('#editor').input_value()=='x\n\n\nyz'
  page.close()

  # A lifecycle invalidation in the middle of a write must not leave an
  # unowned translated value behind. This can happen when the sidebar closes,
  # a tab is rebound, or a writer lease moves during the DOM transaction.
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ta'); ws=hello['writerSession']
  page.locator('#editor').evaluate("(e) => { e.value = 'original'; }")
  page.locator('#editor').evaluate("""(e) => {
    e.addEventListener('input', () => {
      window.__h.msgListeners[0]({ type: 'DETACH', lease: 'L', reason: 'smoke_mid_write' });
    }, { once: true });
  }""")
  r=send(page, {'type':'WRITE_TARGET','requestId':'detach-mid-write','lease':'L','text':'translated','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':False,'force':True})
  assert r and not r['ok'] and r['code'] in {'target_changed', 'invalid_lease'}, r
  assert page.locator('#editor').input_value()=='original', page.locator('#editor').input_value()
  page.close(); b.close()
print('Writer browser smoke: PASS')
