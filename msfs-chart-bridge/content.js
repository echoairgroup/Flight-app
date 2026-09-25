/*
 * Flight-app MSFS Chart Bridge content script.
 *
 * Besides authenticated API calls, this script can drive the actual MSFS
 * Planner chart list. That is important because the /pages API returns an
 * FsChartPageUrl handle; Planner only creates the signed Azure image request
 * after the user-facing chart row is opened.
 */

const CHART_WORDS = /\b(RWY|ILS|LOC|LLZ|RNAV|RNP|GLS|VOR|NDB|TACAN|SID|STAR|DEPARTURE|ARRIVAL|APPROACH|APCH|VISUAL|DIAGRAM|TAXI|PARKING|GROUND|APRON|MINIMA|BRIEFING|AFC|AGC|APC|ADC|AOI|LVC|IAC|VAC|MVC|10-9)\b/i;
const OPEN_BUTTON = 'img[alt="Preview chart"]';
const BADGE = '.vertical-writing-lr';
const TITLE = 'div.grow.cursor-default';
const SOURCE_LABELS = /^(LIDO|FAA|JEPP|JEPPESEN|NAVBLUE)$/i;
const TAB_LABEL = /^[A-Za-z]{3,12}$/;
const CHART_TIMEOUT_MS = 20000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function textOf(element) {
  return (element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function textIn(root, selector) {
  const found = root.querySelector(selector);
  return found ? textOf(found) : '';
}

function normalize(text) {
  return String(text || '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function providerButtons() {
  return [...document.querySelectorAll('button[aria-pressed]')]
    .filter(button => SOURCE_LABELS.test(textOf(button)));
}

function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect.width > 0 &&
    rect.height > 0;
}

function elementLabel(element) {
  if (!element) return '';
  return normalize(
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.textContent ||
    ''
  );
}

function categoryAliases(category) {
  const wanted = String(category || '').toUpperCase();

  if (wanted === 'SID' || wanted === 'SIDPT' || wanted === 'EOSID') {
    return ['departure', 'departures', 'sid', 'sids'];
  }

  if (wanted === 'STAR' || wanted === 'STARPT') {
    return ['arrival', 'arrivals', 'star', 'stars'];
  }

  if (wanted === 'IAC' || wanted === 'VAC') {
    return ['approach', 'approaches', 'apch', 'iac'];
  }

  if (['AOI', 'AGC', 'APC', 'AFC', 'LVC'].includes(wanted)) {
    return ['airport', 'airports', 'airport charts'];
  }

  if (wanted === 'MRC') {
    return ['misc', 'miscellaneous', 'enroute', 'en route', 'en-route'];
  }

  return [wanted.toLowerCase()];
}

function categoryTabs() {
  /*
   * Planner's chart navigation is not guaranteed to use native buttons.
   * Some builds put the visible label on a div/span and make a parent
   * element clickable. Therefore we first inspect normal interactive
   * elements and then fall back to visible elements whose complete text is
   * exactly a known category label.
   */
  const aliases = new Set([
    'departure', 'departures', 'sid', 'sids',
    'arrival', 'arrivals', 'star', 'stars',
    'approach', 'approaches', 'apch', 'iac', 'iacs',
    'airport', 'airports', 'airport charts',
    'misc', 'miscellaneous', 'enroute', 'en route', 'en-route'
  ]);

  const seen = new Set();
  const result = [];

  const add = element => {
    if (!element || seen.has(element) || !isVisible(element)) return;
    const label = elementLabel(element);
    if (!aliases.has(label)) return;
    seen.add(element);
    result.push(element);
  };

  // Normal interactive controls.
  for (const element of document.querySelectorAll(
    'button,[role="tab"],[role="button"],a,[tabindex]'
  )) {
    add(element);
  }

  // Fallback: the category text itself may live on a div/span.
  for (const element of document.querySelectorAll('div,span')) {
    if (!isVisible(element)) continue;
    const label = normalize(textOf(element));
    if (!aliases.has(label)) continue;

    // Prefer the nearest genuinely clickable ancestor.
    const clickable = element.closest(
      'button,[role="tab"],[role="button"],a,[tabindex]'
    );

    add(clickable || element);
  }

  return result;
}

function categoryElementFor(category) {
  const aliases = categoryAliases(category);

  return categoryTabs().find(element => {
    const label = elementLabel(element);
    return aliases.includes(label);
  }) || null;
}

function chartRows() {
  /*
   * The Planner uses a virtualised list. The old [data-index] selector is
   * not part of the public DOM contract and breaks when Planner is rebuilt.
   * Instead locate actual preview buttons and their nearest meaningful row.
   */
  const buttons = [
    ...document.querySelectorAll('img[alt="Preview chart"]')
  ]
    .map(image => image.closest('button') || image)
    .filter(isVisible);

  const rows = [];
  const seen = new Set();

  for (const button of buttons) {
    let row = button;

    // Walk upward until we reach a compact chart-card/list-item container.
    for (let level = 0; level < 7 && row.parentElement; level++) {
      const parent = row.parentElement;
      const text = textOf(parent);

      if (
        text.length >= 3 &&
        text.length <= 500 &&
        parent.querySelector('img[alt="Preview chart"]') &&
        parent.clientHeight >= 30 &&
        parent.clientHeight <= 500
      ) {
        row = parent;
      } else {
        break;
      }
    }

    if (!seen.has(row)) {
      seen.add(row);
      rows.push(row);
    }
  }

  return rows;
}

function listScroller(row) {
  for (let node = row; node && node !== document.body; node = node.parentElement) {
    if (node.clientHeight > 40 && node.scrollHeight > node.clientHeight + 20) {
      return node;
    }
  }
  return null;
}

function isSelected(tab) {
  if (!tab) return false;

  const ariaSelected = tab.getAttribute('aria-selected');
  if (ariaSelected === 'true') return true;

  const className = String(tab.className || '');
  return /border-b-msfs\b|active|selected/i.test(className);
}

async function switchToCategory(category) {
  const aliases = categoryAliases(category);
  const tabs = categoryTabs();

  let tab = tabs.find(candidate => aliases.includes(elementLabel(candidate)));

  // A few Planner builds render category labels inside a button span. Search
  // one level upward when the text node itself is not the clickable control.
  if (!tab) {
    const textMatches = [...document.querySelectorAll('button,[role="tab"],[role="button"],a')]
      .filter(isVisible)
      .filter(element => {
        const label = normalize(textOf(element));
        return aliases.includes(label);
      });

    tab = textMatches[0] || null;
  }

  if (!tab) {
    // Last-resort DOM text scan. This is deliberately broad because Planner
    // has used non-semantic div/span navigation controls in different builds.
    for (const element of document.querySelectorAll('div,span')) {
      if (!isVisible(element)) continue;
      const label = normalize(textOf(element));
      if (!aliases.includes(label)) continue;

      const clickable = element.closest(
        'button,[role="tab"],[role="button"],a,[tabindex]'
      ) || element;

      tab = clickable;
      break;
    }
  }

  if (!tab) {
    const visibleLabels = categoryTabs().map(elementLabel).filter(Boolean);
    throw new Error(
      'Could not find the Planner chart category "' +
      aliases[0].toUpperCase() +
      '". Visible chart categories: ' +
      (visibleLabels.length ? visibleLabels.join(', ') : 'none') +
      '.'
    );
  }

  if (!isSelected(tab)) {
    tab.scrollIntoView({ block: 'nearest' });
    tab.click();

    for (let waited = 0; waited < 8000; waited += 150) {
      await wait(150);

      const current = categoryElementFor(category);
      if (current && isSelected(current)) {
        await wait(300);
        return;
      }

      // Some builds do not expose aria-selected/classes. If the chart list
      // changes after the click, that is enough to continue.
      if (chartRows().length) {
        await wait(300);
        return;
      }
    }
  }
}

function rowName(row) {
  const badge = textIn(row, BADGE);
  const title = textIn(row, TITLE);
  const chips = [...row.querySelectorAll('button')]
    .map(button => textOf(button))
    .filter(Boolean);

  // Prefer a meaningful procedure chip because Planner's displayed chart title can
  // contain extra runway text while the API metadata name is the cleaner match.
  const rankWords = ['ILS', 'LOC', 'LDA', 'GLS', 'RNAV', 'RNP', 'VOR', 'NDB', 'TACAN'];
  const usable = chips
    .filter(chip => !/^NONE\b/i.test(chip))
    .sort((a, b) => {
      const ai = rankWords.indexOf(a.split(/\s+/)[0].toUpperCase());
      const bi = rankWords.indexOf(b.split(/\s+/)[0].toUpperCase());
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

  let result = usable[0] || title || badge;
  if (/^(SID|SIDPT|STAR|STARPT|EOSID)$/i.test(badge) &&
      result &&
      !new RegExp('\\b' + badge + '\\b', 'i').test(result)) {
    result += ' ' + badge.toUpperCase();
  }

  return result;
}

function matchesTarget(row, targetName) {
  const wanted = normalize(targetName);
  if (!wanted) return false;

  const title = normalize(textIn(row, TITLE));
  const full = normalize(textOf(row));
  const derived = normalize(rowName(row));

  const compact = value => normalize(value)
    .replace(/\b(sidpt|sid|starpt|star|iac|aoi|agc|apc|afc|lvc|mrc)\b/g, '')
    .replace(/\\s+/g, ' ')
    .trim();

  const wantedCompact = compact(wanted);
  const candidates = [
    title,
    full,
    derived,
    compact(title),
    compact(full),
    compact(derived)
  ].filter(Boolean);

  return candidates.some(candidate =>
    candidate === wanted ||
    candidate === wantedCompact ||
    candidate.includes(wanted) ||
    wanted.includes(candidate) ||
    (wantedCompact && candidate.includes(wantedCompact))
  );
}

async function findAndClickChart(targetName, category) {
  await switchToCategory(category);

  const findVisible = () => chartRows().find(row => matchesTarget(row, targetName));

  let row = findVisible();
  if (row) {
    const image = row.querySelector('img[alt="Preview chart"]');
    const button = image?.closest('button') || image;

    if (!button) {
      throw new Error('Found the chart row but not its Preview chart control.');
    }

    button.scrollIntoView({ block: 'center' });
    await wait(100);
    button.click();
    return;
  }

  const initial = chartRows()[0];
  const scroller = initial ? listScroller(initial) : null;

  if (!scroller) {
    for (let retry = 0; retry < 20 && !row; retry += 1) {
      await wait(150);
      row = findVisible();
    }

    if (row) {
      const image = row.querySelector('img[alt="Preview chart"]');
      const button = image?.closest('button') || image;
      if (!button) {
        throw new Error('Found the chart row but not its Preview chart control.');
      }
      button.click();
      return;
    }

    throw new Error(
      'The Planner chart list is visible, but the requested chart "' +
      targetName +
      '" could not be found.'
    );
  }

  const originalTop = scroller.scrollTop;
  const step = Math.max(80, Math.floor(scroller.clientHeight * 0.65));

  scroller.scrollTop = 0;
  await wait(250);

  for (let guard = 0; guard < 400; guard += 1) {
    row = findVisible();

    if (row) {
      const image = row.querySelector('img[alt="Preview chart"]');
      const button = image?.closest('button') || image;

      if (!button) {
        throw new Error('Found the chart row but not its Preview chart control.');
      }

      button.scrollIntoView({ block: 'center' });
      await wait(100);
      button.click();
      return;
    }

    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    await wait(170);

    if (scroller.scrollTop === before) break;

    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3) {
      row = findVisible();

      if (row) {
        const image = row.querySelector('img[alt="Preview chart"]');
        const button = image?.closest('button') || image;

        if (!button) {
          throw new Error('Found the chart row but not its Preview chart control.');
        }

        button.scrollIntoView({ block: 'center' });
        await wait(100);
        button.click();
        return;
      }

      break;
    }
  }

  scroller.scrollTop = originalTop;

  throw new Error(
    'Could not find "' +
    targetName +
    '" in the ' +
    categoryAliases(category)[0] +
    ' chart list.'
  );
}

function chartImages() {
  return [...document.images]
    .map(image => ({
      image,
      url: image.currentSrc || image.src || '',
      loaded: image.complete && image.naturalWidth > 0,
      pixels: image.naturalWidth * image.naturalHeight
    }))
    .filter(entry =>
      /https:\/\/foxtrotatlasprod\.blob\.core\.windows\.net\/charts\/chart-files\//i.test(entry.url) &&
      /\.png(?:\?|$)/i.test(entry.url)
    )
    .sort((a, b) => b.pixels - a.pixels);
}

async function waitForRenderedChart(wantedPath = "", before = new Set()) {

  for (let elapsed = 0; elapsed < CHART_TIMEOUT_MS; elapsed += 150) {
    const loaded = chartImages().filter(entry => entry.loaded && entry.pixels > 0);

    // Best case: Planner's rendered image maps to the page handle path.
    if (wantedPath) {
      const exact = loaded.find(entry => {
        try {
          return new URL(entry.url).pathname === wantedPath;
        } catch {
          return false;
        }
      });

      if (exact) {
        return {
          url: exact.url,
          width: exact.image.naturalWidth,
          height: exact.image.naturalHeight
        };
      }
    }

    // Normal case: the viewer swaps in a new chart image after the row click.
    const fresh = loaded.find(entry => !before.has(entry.url));
    if (fresh) {
      return {
        url: fresh.url,
        width: fresh.image.naturalWidth,
        height: fresh.image.naturalHeight
      };
    }

    // Planner can reuse a browser-cached signed image and keep the same DOM node.
    // Its Resource Timing entry still exposes the exact URL.
    const resources = performance
      .getEntriesByType("resource")
      .map(entry => String(entry.name || ""))
      .filter(url =>
        /^https:\/\/foxtrotatlasprod\.blob\.core\.windows\.net\//i.test(url) &&
        /\/charts\/chart-files\//i.test(url) &&
        /\.png(?:\?|$)/i.test(url)
      );

    if (wantedPath) {
      const exactResource = resources.find(url => {
        try {
          return new URL(url).pathname === wantedPath;
        } catch {
          return false;
        }
      });

      if (exactResource) {
        return {
          url: exactResource,
          width: loaded[0]?.image.naturalWidth || 0,
          height: loaded[0]?.image.naturalHeight || 0
        };
      }
    }

    const newest = resources.find(url => !before.has(url));
    if (newest) {
      const matchingImage =
        loaded.find(entry => entry.url === newest);

      return {
        url: newest,
        width: matchingImage?.image.naturalWidth || 0,
        height: matchingImage?.image.naturalHeight || 0
      };
    }

    await wait(150);
  }

  return null;
}

async function openPlannerChart(message) {
  const category = message?.category || '';
  const targetName = message?.chartName || '';
  const handlePath = (() => {
    try {
      return new URL(String(message?.imageUrl || "")).pathname;
    } catch {
      return String(message?.imageUrl || "").split("?")[0];
    }
  })();

  if (!targetName) {
    throw new Error('No chart name was supplied to the Planner bridge.');
  }

  // Close an open viewer/overlay if the browser currently has one. Escape is the same
  // interaction a user would use and lets the underlying list receive the click.
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }));
  await wait(200);

  const before = new Set(
    chartImages().map(entry => entry.url)
  );

  const beforeResources = performance
    .getEntriesByType("resource")
    .map(entry => String(entry.name || ""))
    .filter(url =>
      /^https:\/\/foxtrotatlasprod\.blob\.core\.windows\.net\//i.test(url) &&
      /\/charts\/chart-files\//i.test(url) &&
      /\.png(?:\?|$)/i.test(url)
    );

  for (const url of beforeResources) before.add(url);

  await findAndClickChart(targetName, category);

  const rendered = await waitForRenderedChart(handlePath, before);
  if (!rendered) {
    throw new Error(
      'Planner opened the chart control, but no rendered Azure chart image appeared within ' +
      (CHART_TIMEOUT_MS / 1000) + ' seconds.'
    );
  }

  return {
    ok: true,
    chartName: targetName,
    category,
    imageUrl: rendered.url,
    width: rendered.width,
    height: rendered.height
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message) return undefined;

  if (message.type === 'MSFS_PLANNER_FETCH_JSON') {
    return (async () => {
      const response = await fetch(message.url, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*'
        },
        cache: 'no-store'
      });

      const responseText = await response.text();
      let data = null;

      try {
        data = JSON.parse(responseText);
      } catch {}

      if (!response.ok) {
        throw new Error('MSFS Planner HTTP ' + response.status);
      }

      if (!data) {
        const preview = responseText.replace(/\s+/g, ' ').trim().slice(0, 180);

        if (/<!doctype html|<html/i.test(responseText)) {
          throw new Error(
            'MSFS Planner returned its web page instead of JSON. Make sure you are logged in.'
          );
        }

        throw new Error(
          'MSFS Planner returned invalid JSON' +
          (preview ? ' — ' + preview : '.')
        );
      }

      return data;
    })();
  }

  if (message.type === 'openPlannerChart') {
    return openPlannerChart(message);
  }

  return undefined;
});
