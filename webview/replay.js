/*
 * Minimal WebView replay runtime.
 * No bundler, ES5+ compatible.
 */
(function(){
  function qsa(root, sel){ try { return root.querySelector(sel); } catch(e){ return null; } }
  function qsaAll(root, sel){ try { return Array.from(root.querySelectorAll(sel)); } catch(e){ return []; } }
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
    var roots = [document];
    var tried = [];
    // Shadow piercing root, if provided
    if (bundle.shadowPiercePath && bundle.shadowPiercePath.length) {
      var deep = querySelectorDeep(bundle.shadowPiercePath);
      if (deep) roots.unshift(deep);
    }
    // Try css / fallbacks / xpath across roots
    for (var r=0; r<roots.length; r++){
      var root = roots[r];
      if (bundle.css) {
        var el = qsa(root, bundle.css); tried.push(bundle.css);
        if (el) return el;
      }
      if (bundle.cssFallbacks) {
        for (var i=0;i<bundle.cssFallbacks.length;i++){
          var sel = bundle.cssFallbacks[i];
          var el2 = qsa(root, sel); tried.push(sel);
          if (el2) return el2;
        }
      }
      if (bundle.xpath && root === document) {
        var x = byXpath(bundle.xpath); tried.push('xpath:'+bundle.xpath);
        if (x) return x;
      }
    }
    // ARIA heuristic
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
  function filterCandidatesByMeta(cands, meta){
    if (!cands || !cands.length || !meta) return cands||[];
    var out = cands.slice();
    if (meta.tag) out = out.filter(function(e){ return (e.tagName||'').toLowerCase() === String(meta.tag).toLowerCase(); });
    if (meta.type) out = out.filter(function(e){ return (e.getAttribute && e.getAttribute('type')) === meta.type; });
    if (meta.nameAttr) out = out.filter(function(e){ return (e.getAttribute && e.getAttribute('name')) === meta.nameAttr; });
    if (meta.idAttr) out = out.filter(function(e){ return (e.getAttribute && e.getAttribute('id')) === meta.idAttr; });
    if (meta.classList && meta.classList.length) out = out.filter(function(e){
      var cl = (e.classList && Array.from(e.classList)) || [];
      var needed = meta.classList.filter(Boolean);
      for (var i=0;i<needed.length;i++) if (cl.indexOf(needed[i]) === -1) return false;
      return true;
    });
    if (meta.textSample && meta.textSample.length) out = out.filter(function(e){
      var t = (e.textContent||'').replace(/\s+/g,' ').trim();
      return t.indexOf(meta.textSample) !== -1;
    });
    if (meta.outerHTMLHash && meta.outerHTMLHash.length) {
      var hash = function(s){
        // Tiny djb2 hash string, hex-ish
        var h=5381; for (var i=0;i<s.length;i++){ h=((h<<5)+h) + s.charCodeAt(i); h|=0; }
        var x = (h>>>0).toString(16);
        return x.slice(0, 8);
      };
      var withHash = out.filter(function(e){
        try { return hash((e.outerHTML||'').slice(0,10000)) === meta.outerHTMLHash.slice(0,8); } catch(_) { return false; }
      });
      if (withHash.length) out = withHash;
    }
    if (meta.bbox) {
      var cx = meta.bbox.x + meta.bbox.width/2; var cy = meta.bbox.y + meta.bbox.height/2;
      out.sort(function(a,b){
        var ra = a.getBoundingClientRect(); var rb = b.getBoundingClientRect();
        var da = Math.pow((ra.left+ra.width/2)-cx,2) + Math.pow((ra.top+ra.height/2)-cy,2);
        var db = Math.pow((rb.left+rb.width/2)-cx,2) + Math.pow((rb.top+rb.height/2)-cy,2);
        return da - db;
      });
    }
    return out;
  }
  function resolveWithMeta(step){
    var meta = step.meta||{};
    // Gather candidates from primary bundle and fallbacks
    var bundles = [step.selectors||{}];
    var alts = step.alternatives||[];
    for (var i=0;i<alts.length;i++) bundles.push(alts[i].selectors||{});
    var candidates = [];
    for (var b=0;b<bundles.length;b++){
      var bundle = bundles[b];
      var roots = [document];
      if (bundle.shadowPiercePath && bundle.shadowPiercePath.length){
        var deep = querySelectorDeep(bundle.shadowPiercePath);
        if (deep) roots.unshift(deep);
      }
      for (var r=0;r<roots.length;r++){
        var root = roots[r];
        if (bundle.css) candidates = candidates.concat(qsaAll(root, bundle.css));
        if (bundle.cssFallbacks) for (var k=0;k<bundle.cssFallbacks.length;k++) candidates = candidates.concat(qsaAll(root, bundle.cssFallbacks[k]));
      }
      if (!candidates.length && bundle.xpath && roots.indexOf(document) !== -1) {
        var x = byXpath(bundle.xpath); if (x) candidates.push(x);
      }
      if (candidates.length) break;
    }
    candidates = filterCandidatesByMeta(candidates, meta);
    return candidates[0] || null;
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
      var metaEl = resolveWithMeta(step);
      var resolved = metaEl ? {el: metaEl, via: 'meta', tried: 0} : resolveWithAlternatives(step);
      var el = metaEl || resolved.el;
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


