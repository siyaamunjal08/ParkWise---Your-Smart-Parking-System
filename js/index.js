// Index Module - Aastik

/**
 * Smart Parking System — Landing Page Scripts
 * Navbar animation | Counter animation | Scroll animation
 */

'use strict';

/* ---------- Constants ---------- */
const SCROLL_NAV_THRESHOLD = 60;
const COUNTER_DURATION = 2000;
const STYLE_ELEMENT_ID = 'index-js-styles';

/* ---------- Utility Functions ---------- */

/**
 * Parse a formatted stat string into a numeric value.
 * @param {string} text - e.g. "1,250"
 * @returns {number}
 */
const parseStatValue = (text) => Number(text.replace(/,/g, ''));

/**
 * Format a number with locale-aware comma separators.
 * @param {number} value
 * @returns {string}
 */
const formatStatValue = (value) => Math.round(value).toLocaleString('en-US');

/**
 * Check if the user prefers reduced motion.
 * @returns {boolean}
 */
const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Linear easing for counter animation frames.
 * @param {number} elapsed
 * @param {number} duration
 * @returns {number} Progress between 0 and 1
 */
const easeOutCubic = (elapsed, duration) => {
  const progress = Math.min(elapsed / duration, 1);
  return 1 - Math.pow(1 - progress, 3);
};

/**
 * Throttle a function to run at most once per wait period.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
const throttle = (fn, wait) => {
  let lastTime = 0;
  return (...args) => {
    const now = Date.now();
    if (now - lastTime >= wait) {
      lastTime = now;
      fn(...args);
    }
  };
};

/* ---------- Dynamic Styles (injected at runtime) ---------- */

/**
 * Inject CSS rules used exclusively by JavaScript features.
 */
const injectDynamicStyles = () => {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    /* Navbar scroll states */
    header {
      transition:
        transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 0.35s ease,
        background 0.35s ease,
        border-color 0.35s ease;
    }

    header.nav-scrolled {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      background: rgba(15, 23, 42, 0.92);
      border-bottom-color: rgba(99, 102, 241, 0.25);
    }

    header.nav-hidden {
      transform: translateY(-100%);
    }

    header nav a.nav-active {
      color: #f1f5f9;
    }

    header nav a.nav-active::after {
      width: 100%;
    }

    /* Scroll reveal */
    [data-scroll-animate] {
      opacity: 0;
      transform: translateY(36px);
      transition:
        opacity 0.65s cubic-bezier(0.4, 0, 0.2, 1),
        transform 0.65s cubic-bezier(0.4, 0, 0.2, 1);
    }

    [data-scroll-animate].is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    [data-scroll-animate].is-visible:nth-child(1) { transition-delay: 0.05s; }
    [data-scroll-animate].is-visible:nth-child(2) { transition-delay: 0.12s; }
    [data-scroll-animate].is-visible:nth-child(3) { transition-delay: 0.19s; }
    [data-scroll-animate].is-visible:nth-child(4) { transition-delay: 0.26s; }


    @media (prefers-reduced-motion: reduce) {
      [data-scroll-animate] {
        opacity: 1;
        transform: none;
        transition: none;
      }

      header {
        transition: none;
      }
    }
  `;

  document.head.appendChild(style);
};

/* ---------- Navbar Animation ---------- */

/**
 * Initialise scroll-based navbar show/hide and active link highlighting.
 */
const initNavbarAnimation = () => {
  const header = document.querySelector('header');
  const navLinks = document.querySelectorAll('header nav a[href^="#"]');
  const sections = Array.from(navLinks)
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);

  if (!header) return;

  let lastScrollY = window.scrollY;
  let ticking = false;

  const updateNavbar = () => {
    const currentScrollY = window.scrollY;

    header.classList.toggle('nav-scrolled', currentScrollY > SCROLL_NAV_THRESHOLD);

    if (currentScrollY > SCROLL_NAV_THRESHOLD) {
      header.classList.toggle('nav-hidden', currentScrollY > lastScrollY && currentScrollY > 200);
    } else {
      header.classList.remove('nav-hidden');
    }

    lastScrollY = currentScrollY;
    ticking = false;
  };

  const onScroll = () => {
    if (!ticking) {
      requestAnimationFrame(updateNavbar);
      ticking = true;
    }
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  updateNavbar();

  if (sections.length === 0) return;

  const navObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        const id = entry.target.id;
        navLinks.forEach((link) => {
          link.classList.toggle('nav-active', link.getAttribute('href') === `#${id}`);
        });
      });
    },
    { rootMargin: '-40% 0px -50% 0px', threshold: 0 }
  );

  sections.forEach((section) => navObserver.observe(section));
};

/* ---------- Counter Animation ---------- */

/**
 * Animate a single stat element from zero to its target value.
 * @param {HTMLElement} element
 * @param {number} target
 * @param {number} duration
 */
const animateCounter = (element, target, duration) => {
  if (prefersReducedMotion()) {
    element.textContent = formatStatValue(target);
    return;
  }

  const startTime = performance.now();

  const step = (currentTime) => {
    const elapsed = currentTime - startTime;
    const progress = easeOutCubic(elapsed, duration);
    const currentValue = target * progress;

    element.textContent = formatStatValue(currentValue);

    if (elapsed < duration) {
      requestAnimationFrame(step);
    } else {
      element.textContent = formatStatValue(target);
    }
  };

  requestAnimationFrame(step);
};

/**
 * Initialise counter animation for parking statistics.
 */
const initCounterAnimation = () => {
  const counters = document.querySelectorAll('#statistics article h3');
  if (counters.length === 0) return;

  const counterObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        const element = entry.target;
        const target = parseStatValue(element.textContent);

        element.textContent = '0';
        animateCounter(element, target, COUNTER_DURATION);

        observer.unobserve(element);
      });
    },
    { threshold: 0.4 }
  );

  counters.forEach((counter) => counterObserver.observe(counter));
};

/* ---------- Scroll Animation ---------- */

/**
 * Mark elements for scroll-triggered reveal animations.
 */
const initScrollAnimations = () => {
  const animateTargets = [
    ...document.querySelectorAll('#features > div > article'),
    ...document.querySelectorAll('#how-it-works ol > li'),
    ...document.querySelectorAll('#statistics > div > article'),
    document.querySelector('#cta'),
  ].filter(Boolean);

  if (animateTargets.length === 0) return;

  if (prefersReducedMotion()) {
    animateTargets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  animateTargets.forEach((el) => el.setAttribute('data-scroll-animate', ''));

  const scrollObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  animateTargets.forEach((el) => scrollObserver.observe(el));
};


/* ---------- Initialise ---------- */

document.addEventListener('DOMContentLoaded', () => {
  injectDynamicStyles();
  initNavbarAnimation();
  initCounterAnimation();
  initScrollAnimations();

});
