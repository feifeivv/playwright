/**
 * Copyright 2019 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dom from './dom';
import { Rect } from '../common/types';
import { helper } from './helper';
import { Page } from './page';
import { Frame } from './frames';
import { ParsedSelector } from './common/selectorParser';
import * as types from './types';
import { Progress } from './progress';
import { assert } from '../utils/utils';
import { MultiMap } from '../utils/multimap';

declare global {
  interface Window {
    __cleanupScreenshot?: () => void;
  }
}

export type ScreenshotOptions = {
  type?: 'png' | 'jpeg',
  quality?: number,
  omitBackground?: boolean,
  animations?: 'disabled' | 'allow',
  mask?: { frame: Frame, selector: string}[],
  fullPage?: boolean,
  clip?: Rect,
  size?: 'css' | 'device',
  fonts?: 'ready' | 'nowait',
  caret?: 'hide' | 'initial',
};

export class Screenshotter {
  private _queue = new TaskQueue();
  private _page: Page;

  constructor(page: Page) {
    this._page = page;
    this._queue = new TaskQueue();
  }

  private async _originalViewportSize(progress: Progress): Promise<{ viewportSize: types.Size, originalViewportSize: types.Size | null }> {
    const originalViewportSize = this._page.viewportSize();
    let viewportSize = originalViewportSize;
    if (!viewportSize)
      viewportSize = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => ({ width: window.innerWidth, height: window.innerHeight }));
    return { viewportSize, originalViewportSize };
  }

  private async _fullPageSize(progress: Progress): Promise<types.Size> {
    const fullPageSize = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => {
      if (!document.body || !document.documentElement)
        return null;
      return {
        width: Math.max(
            document.body.scrollWidth, document.documentElement.scrollWidth,
            document.body.offsetWidth, document.documentElement.offsetWidth,
            document.body.clientWidth, document.documentElement.clientWidth
        ),
        height: Math.max(
            document.body.scrollHeight, document.documentElement.scrollHeight,
            document.body.offsetHeight, document.documentElement.offsetHeight,
            document.body.clientHeight, document.documentElement.clientHeight
        ),
      };
    });
    return fullPageSize!;
  }

  async screenshotPage(progress: Progress, options: ScreenshotOptions): Promise<Buffer> {
    const format = validateScreenshotOptions(options);
    return this._queue.postTask(async () => {
      progress.log('taking page screenshot');
      const { viewportSize } = await this._originalViewportSize(progress);
      await this._preparePageForScreenshot(progress, options.caret !== 'initial', options.animations === 'disabled', options.fonts === 'ready');
      progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.

      if (options.fullPage) {
        const fullPageSize = await this._fullPageSize(progress);
        let documentRect = { x: 0, y: 0, width: fullPageSize.width, height: fullPageSize.height };
        const fitsViewport = fullPageSize.width <= viewportSize.width && fullPageSize.height <= viewportSize.height;
        if (options.clip)
          documentRect = trimClipToSize(options.clip, documentRect);
        const buffer = await this._screenshot(progress, format, documentRect, undefined, fitsViewport, options);
        progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.
        await this._restorePageAfterScreenshot();
        return buffer;
      }

      const viewportRect = options.clip ? trimClipToSize(options.clip, viewportSize) : { x: 0, y: 0, ...viewportSize };
      const buffer = await this._screenshot(progress, format, undefined, viewportRect, true, options);
      progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.
      await this._restorePageAfterScreenshot();
      return buffer;
    });
  }

  async screenshotElement(progress: Progress, handle: dom.ElementHandle, options: ScreenshotOptions): Promise<Buffer> {
    const format = validateScreenshotOptions(options);
    return this._queue.postTask(async () => {
      progress.log('taking element screenshot');
      const { viewportSize } = await this._originalViewportSize(progress);

      await this._preparePageForScreenshot(progress, options.caret !== 'initial', options.animations === 'disabled', options.fonts === 'ready');
      progress.throwIfAborted(); // Do not do extra work.

      await handle._waitAndScrollIntoViewIfNeeded(progress);

      progress.throwIfAborted(); // Do not do extra work.
      const boundingBox = await handle.boundingBox();
      assert(boundingBox, 'Node is either not visible or not an HTMLElement');
      assert(boundingBox.width !== 0, 'Node has 0 width.');
      assert(boundingBox.height !== 0, 'Node has 0 height.');

      const fitsViewport = boundingBox.width <= viewportSize.width && boundingBox.height <= viewportSize.height;
      progress.throwIfAborted(); // Avoid extra work.
      const scrollOffset = await this._page.mainFrame().waitForFunctionValueInUtility(progress, () => ({ x: window.scrollX, y: window.scrollY }));
      const documentRect = { ...boundingBox };
      documentRect.x += scrollOffset.x;
      documentRect.y += scrollOffset.y;
      const buffer = await this._screenshot(progress, format, helper.enclosingIntRect(documentRect), undefined, fitsViewport, options);
      progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.
      await this._restorePageAfterScreenshot();
      return buffer;
    });
  }

  async _preparePageForScreenshot(progress: Progress, hideCaret: boolean, disableAnimations: boolean, waitForFonts: boolean) {
    if (disableAnimations)
      progress.log('  disabled all CSS animations');
    if (waitForFonts)
      progress.log('  waiting for fonts to load...');
    await Promise.all(this._page.frames().map(async frame => {
      await frame.nonStallingEvaluateInExistingContext('(' + (async function(hideCaret: boolean, disableAnimations: boolean, waitForFonts: boolean) {
        const styleTag = document.createElement('style');
        if (hideCaret) {
          styleTag.textContent = `
            *:not(#playwright-aaaaaaaaaa.playwright-bbbbbbbbbbb.playwright-cccccccccc.playwright-dddddddddd.playwright-eeeeeeeee) {
              caret-color: transparent !important;
            }
          `;
          document.documentElement.append(styleTag);
        }
        const infiniteAnimationsToResume: Set<Animation> = new Set();
        const cleanupCallbacks: (() => void)[] = [];

        if (disableAnimations) {
          const collectRoots = (root: Document | ShadowRoot, roots: (Document|ShadowRoot)[] = []): (Document|ShadowRoot)[] => {
            roots.push(root);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            do {
              const node = walker.currentNode;
              const shadowRoot = node instanceof Element ? node.shadowRoot : null;
              if (shadowRoot)
                collectRoots(shadowRoot, roots);
            } while (walker.nextNode());
            return roots;
          };
          const handleAnimations = (root: Document|ShadowRoot): void => {
            for (const animation of root.getAnimations()) {
              if (!animation.effect || animation.playbackRate === 0 || infiniteAnimationsToResume.has(animation))
                continue;
              const endTime = animation.effect.getComputedTiming().endTime;
              if (Number.isFinite(endTime)) {
                try {
                  animation.finish();
                } catch (e) {
                  // animation.finish() should not throw for
                  // finite animations, but we'd like to be on the
                  // safe side.
                }
              } else {
                try {
                  animation.cancel();
                  infiniteAnimationsToResume.add(animation);
                } catch (e) {
                  // animation.cancel() should not throw for
                  // infinite animations, but we'd like to be on the
                  // safe side.
                }
              }
            }
          };
          for (const root of collectRoots(document)) {
            const handleRootAnimations: (() => void) = handleAnimations.bind(null, root);
            handleRootAnimations();
            root.addEventListener('transitionrun', handleRootAnimations);
            root.addEventListener('animationstart', handleRootAnimations);
            cleanupCallbacks.push(() => {
              root.removeEventListener('transitionrun', handleRootAnimations);
              root.removeEventListener('animationstart', handleRootAnimations);
            });
          }
        }

        window.__cleanupScreenshot = () => {
          styleTag.remove();
          for (const animation of infiniteAnimationsToResume) {
            try {
              animation.play();
            } catch (e) {
              // animation.play() should never throw, but
              // we'd like to be on the safe side.
            }
          }
          for (const cleanupCallback of cleanupCallbacks)
            cleanupCallback();
          delete window.__cleanupScreenshot;
        };

        if (waitForFonts)
          await document.fonts.ready;
      }).toString() + `)(${hideCaret}, ${disableAnimations}, ${waitForFonts})`, false, 'utility').catch(() => {});
    }));
    if (waitForFonts)
      progress.log('  fonts in all frames are loaded');
    progress.cleanupWhenAborted(() => this._restorePageAfterScreenshot());
  }

  async _restorePageAfterScreenshot() {
    await Promise.all(this._page.frames().map(async frame => {
      frame.nonStallingEvaluateInExistingContext('window.__cleanupScreenshot && window.__cleanupScreenshot()', false, 'utility').catch(() => {});
    }));
  }

  async _maskElements(progress: Progress, options: ScreenshotOptions) {
    if (!options.mask || !options.mask.length)
      return false;

    const framesToParsedSelectors: MultiMap<Frame, ParsedSelector> = new MultiMap();
    await Promise.all((options.mask || []).map(async ({ frame, selector }) => {
      const pair = await frame.resolveFrameForSelectorNoWait(selector);
      if (pair)
        framesToParsedSelectors.set(pair.frame, pair.info.parsed);
    }));
    progress.throwIfAborted(); // Avoid extra work.

    await Promise.all([...framesToParsedSelectors.keys()].map(async frame => {
      await frame.maskSelectors(framesToParsedSelectors.get(frame));
    }));
    progress.cleanupWhenAborted(() => this._page.hideHighlight());
    return true;
  }

  private async _screenshot(progress: Progress, format: 'png' | 'jpeg', documentRect: types.Rect | undefined, viewportRect: types.Rect | undefined, fitsViewport: boolean, options: ScreenshotOptions): Promise<Buffer> {
    if ((options as any).__testHookBeforeScreenshot)
      await (options as any).__testHookBeforeScreenshot();
    progress.throwIfAborted(); // Screenshotting is expensive - avoid extra work.
    const shouldSetDefaultBackground = options.omitBackground && format === 'png';
    if (shouldSetDefaultBackground) {
      await this._page._delegate.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 });
      progress.cleanupWhenAborted(() => this._page._delegate.setBackgroundColor());
    }
    progress.throwIfAborted(); // Avoid extra work.

    const hasHighlight = await this._maskElements(progress, options);
    progress.throwIfAborted(); // Avoid extra work.

    const buffer = await this._page._delegate.takeScreenshot(progress, format, documentRect, viewportRect, options.quality, fitsViewport, options.size || 'device');
    progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.

    if (hasHighlight)
      await this._page.hideHighlight();
    progress.throwIfAborted(); // Avoid restoring after failure - should be done by cleanup.

    if (shouldSetDefaultBackground)
      await this._page._delegate.setBackgroundColor();
    progress.throwIfAborted(); // Avoid side effects.
    if ((options as any).__testHookAfterScreenshot)
      await (options as any).__testHookAfterScreenshot();
    return buffer;
  }
}

class TaskQueue {
  private _chain: Promise<any>;

  constructor() {
    this._chain = Promise.resolve();
  }

  postTask(task: () => any): Promise<any> {
    const result = this._chain.then(task);
    this._chain = result.catch(() => {});
    return result;
  }
}

function trimClipToSize(clip: types.Rect, size: types.Size): types.Rect {
  const p1 = {
    x: Math.max(0, Math.min(clip.x, size.width)),
    y: Math.max(0, Math.min(clip.y, size.height))
  };
  const p2 = {
    x: Math.max(0, Math.min(clip.x + clip.width, size.width)),
    y: Math.max(0, Math.min(clip.y + clip.height, size.height))
  };
  const result = { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y };
  assert(result.width && result.height, 'Clipped area is either empty or outside the resulting image');
  return result;
}

function validateScreenshotOptions(options: ScreenshotOptions): 'png' | 'jpeg' {
  let format: 'png' | 'jpeg' | null = null;
  // options.type takes precedence over inferring the type from options.path
  // because it may be a 0-length file with no extension created beforehand (i.e. as a temp file).
  if (options.type) {
    assert(options.type === 'png' || options.type === 'jpeg', 'Unknown options.type value: ' + options.type);
    format = options.type;
  }

  if (!format)
    format = 'png';

  if (options.quality !== undefined) {
    assert(format === 'jpeg', 'options.quality is unsupported for the ' + format + ' screenshots');
    assert(typeof options.quality === 'number', 'Expected options.quality to be a number but found ' + (typeof options.quality));
    assert(Number.isInteger(options.quality), 'Expected options.quality to be an integer');
    assert(options.quality >= 0 && options.quality <= 100, 'Expected options.quality to be between 0 and 100 (inclusive), got ' + options.quality);
  }
  if (options.clip) {
    assert(typeof options.clip.x === 'number', 'Expected options.clip.x to be a number but found ' + (typeof options.clip.x));
    assert(typeof options.clip.y === 'number', 'Expected options.clip.y to be a number but found ' + (typeof options.clip.y));
    assert(typeof options.clip.width === 'number', 'Expected options.clip.width to be a number but found ' + (typeof options.clip.width));
    assert(typeof options.clip.height === 'number', 'Expected options.clip.height to be a number but found ' + (typeof options.clip.height));
    assert(options.clip.width !== 0, 'Expected options.clip.width not to be 0.');
    assert(options.clip.height !== 0, 'Expected options.clip.height not to be 0.');
  }
  return format;
}
