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

function categoryTabs() {
  return [...document.querySelectorAll('button')].filter(button => {
    const label = textOf(button);
    return /border-b-(msfs|transparent)\b/.test(String(button.className || '')) &&
      TAB_LABEL.test(label) &&
      !SOURCE_LABELS.test(label);
  });
}

function chartRows() {
  return [...document.querySelectorAll('[data-index]')]
    .filter(row => row.querySelector(OPEN_BUTTON));
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
  return /border-b-msfs\b/.test(String(tab.className || ''));
}

function tabNameForCategory(category) {
  const value = String(category || '').toUpperCase();

  if (value === 'SID' || value === 'SIDPT' || value === 'EOSID') return 'DEPARTURE';
  if (value === 'STAR' || value === 'STARPT') return 'ARRIVAL';
  if (value === 'IAC' || value === 'VAC') return 'APPROACH';
  if (['AOI', 'AGC', 'APC', 'AFC', 'LVC'].includes(value)) return 'AIRPORT';
  if (value === 'MRC') return 'MISC';

  return value;
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

  return title === wanted ||
    derived === wanted ||
    full.includes(wanted) ||
    wanted.includes(title) ||
    wanted.includes(derived);
}

async function switchToCategory(category) {
  const wanted = tabNameForCategory(category);
  const tabs = categoryTabs();
  let tab = tabs.find(candidate => textOf(candidate).toUpperCase() === wanted);

  // Some Planner builds use ARRIVAL/DEPARTURE labels, while others can expose a
  // more direct chart category. Fall back to the raw category when present.
  if (!tab) {
    tab = tabs.find(candidate => textOf(candidate).toUpperCase() === String(category || '').toUpperCase());
  }

  if (!tab) {
    throw new Error('Could not find the Planner chart category "' + wanted + '".');
  }

  if (!isSelected(tab)) {
    tab.click();

    for (let waited = 0; waited < 6000; waited += 150) {
      await wait(150);
      const current = categoryTabs().find(candidate =>
        textOf(candidate).toUpperCase() === wanted
      );
      if (current && isSelected(current)) {
        await wait(300);
        break;
      }
    }
  }
}

async function findAndClickChart(targetName, category) {
  await switchToCategory(category);

  const findVisible = () => chartRows().find(row => matchesTarget(row, targetName));

  let row = findVisible();
  if (row) {
    const image = row.querySelector(OPEN_BUTTON);
    const button = image?.closest('button') || image;
    if (!button) throw new Error('Found the chart row but not its Preview chart button.');
    button.scrollIntoView({ block: 'center' });
    await wait(80);
    button.click();
    return;
  }

  const initial = chartRows()[0];
  const scroller = initial ? listScroller(initial) : null;

  if (!scroller) {
    // Give React a chance to mount the virtualised list before failing.
    for (let retry = 0; retry < 12 && !row; retry += 1) {
      await wait(150);
      row = findVisible();
    }
    if (row) {
      const image = row.querySelector(OPEN_BUTTON);
      const button = image?.closest('button') || image;
      button?.click();
      return;
    }

    throw new Error('The Planner chart list is present, but the requested chart row could not be found.');
  }

  const originalTop = scroller.scrollTop;
  const step = Math.max(60, Math.floor(scroller.clientHeight * 0.6));

  scroller.scrollTop = 0;
  await wait(220);

  for (let guard = 0; guard < 350; guard += 1) {
    row = findVisible();
    if (row) {
      const image = row.querySelector(OPEN_BUTTON);
      const button = image?.closest('button') || image;
      if (!button) throw new Error('Found the chart row but not its Preview chart button.');
      button.scrollIntoView({ block: 'center' });
      await wait(80);
      button.click();
      return;
    }

    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    await wait(160);

    if (scroller.scrollTop === before) break;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      row = findVisible();
      if (row) {
        const image = row.querySelector(OPEN_BUTTON);
        const button = image?.closest('button') || image;
        button?.scrollIntoView({ block: 'center' });
        await wait(80);
        button?.click();
        return;
      }
      break;
    }
  }

  scroller.scrollTop = originalTop;
  throw new Error(
    'Could not find "' + targetName + '" in the ' + tabNameForCategory(category) + ' chart list.'
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

async function waitForRenderedChart(wantedPath = "") {
  const before = new Set(chartImages().map(entry => entry.url));

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

  await findAndClickChart(targetName, category);

  const rendered = await waitForRenderedChart(handlePath);
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
