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
  page.close()

  # The real writable node may be a short inner Lexical editor while the
  # message hint lives on its parent and the empty-state Send button is disabled.
  page=b.new_page(viewport={'width':1200,'height':800})
  page.set_content('''<!doctype html><body>
    <div style="height:610px"></div>
    <form data-testid="chat-input" aria-label="Compose message" onsubmit="return false">
      <div id="editor" contenteditable="true" data-lexical-editor="true" role="textbox"
           style="width:700px;height:14px;border:1px solid"></div>
      <button id="send" type="button" aria-label="Send message" disabled>Send</button>
    </form>
  </body>''')
  page.evaluate('''() => {const messages=[];const msgListeners=[];const disconnect=[];const port={postMessage(m){messages.push(structuredClone(m));},onMessage:{addListener(fn){msgListeners.push(fn)}},onDisconnect:{addListener(fn){disconnect.push(fn)}},disconnect(){for(const fn of disconnect)fn();}};window.__h={messages,msgListeners,disconnect};window.chrome={runtime:{id:'test',connect(){return port}}};}''')
  page.add_script_tag(content=js); page.wait_for_timeout(30)
  hello=page.evaluate('window.__h.messages.find(m=>m.type==="WRITER_HELLO")'); ws=hello['writerSession']
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'ATTACH','lease':'L'}); page.wait_for_timeout(100)
  st=send(page, {'type':'REQUEST_WRITER_STATE','requestId':'parent-hint-state','lease':'L'})
  assert st['ok'] and st['state']['composerReady'], (st, page.evaluate('window.__h.messages'))
  r=send(page, {'type':'WRITE_TARGET','requestId':'parent-hint-write','lease':'L','text':'detected','expectedWriterSession':ws,'expectedTargetEpoch':st['state']['targetEpoch'],'allowFocus':True})
  assert r['ok'] and page.locator('#editor').inner_text()=='detected', r
  page.close()

  # Manual binding must survive a React/Lexical node replacement after
  # pointerdown, and an in-flight verification must cancel after detach.
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ce')
  page.locator('#editor').evaluate('''(e) => e.addEventListener('pointerdown', () => {
    const replacement = e.cloneNode(false);
    replacement.id = 'editor';
    e.replaceWith(replacement);
  }, { once: true })''')
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'START_MANUAL_BIND','requestId':'manual-replace','lease':'L'})
  page.wait_for_timeout(20); page.locator('#editor').click(); page.wait_for_timeout(320)
  manual_result=page.evaluate('window.__h.messages.findLast(m=>m.type==="START_MANUAL_BIND_RESULT" && m.requestId==="manual-replace")')
  assert manual_result and manual_result['ok'] and manual_result['state']['composerReady'], (manual_result, page.evaluate('window.__h.messages'))
  r=send(page, {'type':'WRITE_TARGET','requestId':'manual-replace-write','lease':'L','text':'replacement bound','expectedWriterSession':manual_result['writerSession'],'expectedTargetEpoch':manual_result['targetEpoch'],'allowFocus':True})
  assert r['ok'] and page.locator('#editor').inner_text()=='replacement bound', r

  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'START_MANUAL_BIND','requestId':'manual-cancel','lease':'L'})
  page.wait_for_timeout(20); page.locator('#editor').click()
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'DETACH','lease':'L','reason':'manual_bind_cancel_test'})
  page.wait_for_timeout(320)
  cancelled=page.evaluate('window.__h.messages.findLast(m=>m.type==="START_MANUAL_BIND_RESULT" && m.requestId==="manual-cancel")')
  assert cancelled and not cancelled['ok'] and cancelled['code']=='manual_bind_cancelled', (cancelled, page.evaluate('window.__h.messages'))
  page.close()

  # A real send may unmount the composer before any replacement is locatable.
  # The trusted in-TTL Enter intent must still confirm the send instead of
  # degrading into a false TARGET_CLEARED that never archives the draft.
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ce'); ws=hello['writerSession']
  r=send(page, {'type':'WRITE_TARGET','requestId':'rm-w','lease':'L','text':'will send','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':True})
  assert r['ok'], r
  page.locator('#editor').evaluate('''(e) => e.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    setTimeout(() => e.remove(), 30);
  })''')
  page.locator('#editor').click(); page.keyboard.press('Enter')
  page.wait_for_timeout(400)
  sent=page.evaluate('window.__h.messages.findLast(m=>m.type==="SEND_CONFIRMED")')
  assert sent and sent['sentText']=='will send', (sent, page.evaluate('window.__h.messages'))
  page.close()

  # A plain Enter that only appends a trailing blank block (ProseMirror-style:
  # Enter handled in keydown, native input events suppressed, normalized text
  # unchanged) is editing, not sending. A page-side clear afterwards must be
  # reported as TARGET_CLEARED, never archived as a confirmed send.
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ce'); ws=hello['writerSession']
  r=send(page, {'type':'WRITE_TARGET','requestId':'tr-w','lease':'L','text':'kept text','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':True})
  assert r['ok'], r
  page.locator('#editor').evaluate('''(e) => e.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    e.appendChild(paragraph);
  })''')
  page.locator('#editor').click(); page.keyboard.press('Enter')
  page.wait_for_timeout(150)
  page.locator('#editor').evaluate('(e)=>e.replaceChildren()')
  page.wait_for_timeout(150)
  cleared=page.evaluate('window.__h.messages.findLast(m=>m.type==="TARGET_CLEARED")')
  false_send=page.evaluate('window.__h.messages.findLast(m=>m.type==="SEND_CONFIRMED")')
  assert cleared and cleared['previousText']=='kept text', (cleared, page.evaluate('window.__h.messages'))
  assert not false_send, false_send
  page.close()

  # While detached nothing observes SPA navigation, so a later attach must
  # adopt the URL up front with a silent session rotation: the panel adopts
  # the fresh state wholesale, and the first write must succeed instead of
  # failing writer_session_changed with a forced pause.
  page=b.new_page(viewport={'width':1200,'height':800}); hello=setup(page,'ce'); ws=hello['writerSession']
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'DETACH','lease':'L','reason':'smoke_nav_detach'})
  page.evaluate('history.pushState({}, "", "#other-conversation")')
  page.wait_for_timeout(30)
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'ATTACH','lease':'L2'})
  page.wait_for_timeout(80)
  attached_state=page.evaluate('window.__h.messages.findLast(m=>m.type==="WRITER_STATE" && m.reason==="attached")')
  assert attached_state and attached_state['writerSession']!=ws, (attached_state, ws)
  assert not page.evaluate('window.__h.messages.some(m=>m.type==="WRITER_SESSION_CHANGED")'), page.evaluate('window.__h.messages')
  r=send(page, {'type':'WRITE_TARGET','requestId':'nav-w','lease':'L2','text':'post nav','expectedWriterSession':attached_state['writerSession'],'expectedTargetEpoch':attached_state['state']['targetEpoch'],'allowFocus':True})
  assert r['ok'] and page.locator('#editor').inner_text()=='post nav', r
  page.close()

  # Manually binding to a different, empty editor while the previous editor
  # still holds its text untouched clears nothing and sends nothing: it must
  # not fabricate a TARGET_CLEARED "externally cleared" pause.
  page=b.new_page(viewport={'width':1200,'height':800})
  page.set_content('''<!doctype html><body><div style="height:500px"></div>
    <form onsubmit="return false">
      <div id="editor" contenteditable="true" role="textbox" aria-label="Message Claude" style="width:700px;height:120px;border:1px solid"></div>
      <button id="send" type="button" aria-label="Send message">Send</button>
    </form>
    <div id="second" contenteditable="true" style="width:500px;height:80px;border:1px solid"></div>
  </body>''')
  page.evaluate('''() => {const messages=[];const msgListeners=[];const disconnect=[];const port={postMessage(m){messages.push(structuredClone(m));},onMessage:{addListener(fn){msgListeners.push(fn)}},onDisconnect:{addListener(fn){disconnect.push(fn)}},disconnect(){for(const fn of disconnect)fn();}};window.__h={messages,msgListeners,disconnect};window.chrome={runtime:{id:'test',connect(){return port}}};}''')
  page.add_script_tag(content=js); page.wait_for_timeout(30)
  hello=page.evaluate('window.__h.messages.find(m=>m.type==="WRITER_HELLO")'); ws=hello['writerSession']
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'ATTACH','lease':'L'}); page.wait_for_timeout(60)
  r=send(page, {'type':'WRITE_TARGET','requestId':'mb-w','lease':'L','text':'still here','expectedWriterSession':ws,'expectedTargetEpoch':0,'allowFocus':True})
  assert r['ok'], r
  page.evaluate('(m)=>window.__h.msgListeners[0](m)', {'type':'START_MANUAL_BIND','requestId':'manual-switch','lease':'L'})
  page.wait_for_timeout(20); page.locator('#second').click(); page.wait_for_timeout(320)
  manual_switch=page.evaluate('window.__h.messages.findLast(m=>m.type==="START_MANUAL_BIND_RESULT" && m.requestId==="manual-switch")')
  assert manual_switch and manual_switch['ok'] and manual_switch['state']['composerReady'], (manual_switch, page.evaluate('window.__h.messages'))
  assert not page.evaluate('window.__h.messages.some(m=>m.type==="TARGET_CLEARED")'), page.evaluate('window.__h.messages')
  assert page.locator('#editor').inner_text()=='still here'
  page.close(); b.close()
print('Writer browser smoke: PASS')
