/*
 * Minimal WebView replay runtime.
 * No bundler, ES5+ compatible.
 */
(function(){
  function qsa(root, sel){ try { return root.querySelector(sel); } catch(e){ return null; } }
  function byXpath(xpath){
    try {
      var r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue || null;
    } catch(e){ return null; }
  }
  function querySelectorDeep(path){
    // path: array of host labels; best-effort
    var cur = document;
    for (var i=0;i<path.length;i++){
      var label = path[i];
      var host = document.querySelector(label);
      if (!host || !host.shadowRoot) return null;
      cur = host.shadowRoot;
    }
    return cur;
  }
  function resolveSelectorBundle(bundle){
    if (bundle.css) {
      var el = qsa(document, bundle.css);
      if (el) return el;
    }
    if (bundle.cssFallbacks) {
      for (var i=0;i<bundle.cssFallbacks.length;i++){
        var el2 = qsa(document, bundle.cssFallbacks[i]);
        if (el2) return el2;
      }
    }
    if (bundle.xpath) {
      var x = byXpath(bundle.xpath);
      if (x) return x;
    }
    if (bundle.shadowPiercePath && bundle.css) {
      var root = querySelectorDeep(bundle.shadowPiercePath);
      if (root) {
        var el3 = qsa(root, bundle.css);
        if (el3) return el3;
      }
    }
    // naive ARIA heuristic
    if (bundle.aria && bundle.aria.role) {
      var candidates = document.querySelectorAll('[role="'+bundle.aria.role+'"]');
      for (var j=0;j<candidates.length;j++){
        var c = candidates[j];
        if (!bundle.aria.name) return c;
        if ((c.textContent||'').indexOf(bundle.aria.name) !== -1) return c;
      }
    }
    return null;
  }
  function resolveWithAlternatives(step){
    var tried = 0;
    var el = resolveSelectorBundle(step.selectors||{});
    tried++;
    if (el) return {el: el, via: 'primary', tried: tried};
    var alts = step.alternatives||[];
    for (var i=0;i<alts.length;i++){
      var alt = alts[i];
      var elAlt = resolveSelectorBundle(alt.selectors||{});
      tried++;
      if (elAlt) return {el: elAlt, via: 'alternative', reason: alt.reason||'', tried: tried};
    }
    return {el: null, via: 'none', tried: tried};
  }
  function scrollIntoViewCentered(el){ try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){} }
  function act(step, el){
    if (step.kind === 'click'){
      scrollIntoViewCentered(el);
      var ev1 = new MouseEvent('pointerdown', {bubbles:true, cancelable:true}); el.dispatchEvent(ev1);
      var ev2 = new MouseEvent('mousedown', {bubbles:true, cancelable:true}); el.dispatchEvent(ev2);
      var ev3 = new MouseEvent('mouseup', {bubbles:true, cancelable:true}); el.dispatchEvent(ev3);
      var ev4 = new MouseEvent('click', {bubbles:true, cancelable:true}); el.dispatchEvent(ev4);
      return Promise.resolve();
    }
    if (step.kind === 'fill'){
      el.value = step.value || '';
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return Promise.resolve();
    }
    if (step.kind === 'select'){
      el.value = step.value || '';
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return Promise.resolve();
    }
    if (step.kind === 'press'){
      var kd = new KeyboardEvent('keydown', {bubbles:true, key: step.value||''}); el.dispatchEvent(kd);
      var ku = new KeyboardEvent('keyup', {bubbles:true, key: step.value||''}); el.dispatchEvent(ku);
      return Promise.resolve();
    }
    return Promise.resolve();
  }
  function waitFor(doneWhen, timeout){
    if (!doneWhen) return Promise.resolve();
    var start = Date.now();
    return new Promise(function(resolve, reject){
      var iv = setInterval(function(){
        if (doneWhen.selectorVisible) {
          var el = document.querySelector(doneWhen.selectorVisible);
          if (el && el.offsetParent !== null) { clearInterval(iv); resolve(); return; }
        }
        if (doneWhen.urlMatches) {
          try { if (new RegExp(doneWhen.urlMatches).test(location.href)) { clearInterval(iv); resolve(); return; } } catch(e){}
        }
        if (doneWhen.textPresent) {
          var root = document.querySelector(doneWhen.textPresent.selector);
          if (root && (root.textContent||'').indexOf(doneWhen.textPresent.includes) !== -1) { clearInterval(iv); resolve(); return; }
        }
        if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error('waitFor timeout')); }
      }, 100);
    });
  }

  function resolveSelectorBundleWithFrames(bundle){
    // Frame support is best effort; cross-origin not supported here.
    // For safety, we ignore framePath for now in this minimal stub.
    return resolveSelectorBundle(bundle);
  }

  function replay(steps, options){
    options = options || {};
    var stepTimeoutMs = options.stepTimeoutMs || 8000;
    var i = 0;
    var results = [];
    function next(){
      if (i >= steps.length) return Promise.resolve(results);
      var step = steps[i++];
      var resolved = resolveWithAlternatives(step);
      var el = resolved.el;
      if (!el) {
        results.push({ok:false, error:'Element not found', triedSelectors: resolved.tried});
        return Promise.resolve(results);
      }
      return act(step, el).then(function(){
        return waitFor(step.doneWhen, stepTimeoutMs);
      }).then(function(){
        results.push({ok:true, via: resolved.via, alternativeReason: resolved.reason||null});
        return next();
      }, function(err){
        results.push({ok:false, error:String(err&&err.message||err), via: resolved.via, alternativeReason: resolved.reason||null});
        return next();
      });
    }
    return next();
  }

  window.MCPReplay = { replay: replay, resolveSelectorBundle: resolveSelectorBundle };
})();


