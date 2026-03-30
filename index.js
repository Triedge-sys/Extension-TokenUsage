/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting
 * - getTextTokens() for getting actual token IDs when available
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getTextTokens, getFriendlyTokenizerName, tokenizers } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getGeneratingModel } from '../../../../script.js';

const extensionName = 'token-usage-tracker';

/**
 * Extension configuration constants
 */
const CONFIG = {
    // API URLs
    CURRENCY_API_URL: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    
    // Timing constants (milliseconds)
    MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
    CACHE_DURATION_MS: 24 * 60 * 60 * 1000,  // 24 hours for currency cache
    DEBOUNCE_DELAY_MS: 500,                   // 500ms for price input debounce
    RESIZE_DEBOUNCE_MS: 100,                  // 100ms for chart resize
    PRE_CONTINUE_MAX_WAIT_MS: 5000,           // 5 seconds max wait for pre-continue tokens
    PRE_CONTINUE_WAIT_INTERVAL_MS: 50,        // 50ms polling interval
    INITIAL_STATS_EMIT_DELAY_MS: 1000,        // 1 second after init
    CONNECTION_MANAGER_PATCH_TIMEOUT_MS: 30000, // 30 seconds for patch polling
    
    // Chart configuration
    CHART_RANGES: {
        SHORT: 7,
        MEDIUM: 30,
        LONG: 90
    },
    CHART_COLORS: {
        bar: 'var(--SmartThemeBorderColor)',
        text: 'var(--SmartThemeBodyColor)',
        grid: 'var(--SmartThemeBorderColor)',
        cursor: 'var(--SmartThemeBodyColor)'
    },
    CHART_MARGIN: { top: 10, right: 10, bottom: 25, left: 45 },
    CHART_BAR_MAX_WIDTH: 40,
    CHART_LABEL_INTERVAL: { 7: 1, 30: 3, 90: 7 },
    
    // Token estimation
    IMAGE_TOKEN_ESTIMATE: 765,        // OpenAI high detail mode 1024x1024
    MESSAGE_OVERHEAD_TOKENS: 3,       // Per message boundary overhead
    CHAR_PER_TOKEN_ESTIMATE: 3.35,    // Fallback character-based estimate
    
    // UI selectors
    SELECTORS: {
        CHART_CONTAINER: '#token-usage-chart',
        SETTINGS_CONTAINER: '#extensions_settings2',
        SETTINGS_CONTAINER_FALLBACK: '#extensions_settings',
        TOOLTIP: '#token-usage-tooltip',
        MODEL_COLORS_GRID: '#token-usage-model-colors-grid',
        CURRENCY_TOGGLE: '#token-usage-currency-toggle',
        CURRENCY_SELECTOR: '#token-usage-currency-selector',
        RESET_BUTTON: '#token-usage-reset-all',
        WEEK_CARD: '#token-usage-week-card',
        MONTH_CARD: '#token-usage-month-card',
        ALLTIME_CARD: '#token-usage-alltime-card'
    },
    
    // CSS classes
    CLASSES: {
        RANGE_BUTTON: 'token-usage-range-btn',
        ACTIVE_BUTTON: 'active',
        MODEL_CONFIG_ROW: 'model-config-row',
        CURSOR_RECT: 'cursor-rect'
    },
    
    // Event names
    EVENTS: {
        USAGE_UPDATED: 'tokenUsageUpdated'
    },
    
    // Currency
    DEFAULT_CURRENCY: 'USD',
    POPULAR_CURRENCIES: ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RUB', 'KRW', 'INR', 'BRL', 'CAD', 'AUD', 'CHF', 'PLN', 'UAH', 'KZT'],
    
    // Currency symbols
    CURRENCY_SYMBOLS: {
        'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'CNY': '¥', 'RUB': '₽',
        'KRW': '₩', 'INR': '₹', 'BRL': 'R$', 'AUD': 'A$', 'CAD': 'C$', 'CHF': 'Fr',
        'HKD': 'HK$', 'SGD': 'S$', 'SEK': 'kr', 'NOK': 'kr', 'DKK': 'kr', 'PLN': 'zł',
        'TRY': '₺', 'ZAR': 'R', 'MXN': '$', 'ARS': '$', 'CLP': '$', 'COP': '$',
        'PEN': 'S/', 'UYU': '$U', 'THB': '฿', 'VND': '₫', 'IDR': 'Rp', 'MYR': 'RM',
        'PHP': '₱', 'AED': 'د.إ', 'SAR': '﷼', 'ILS': '₪', 'EGP': 'E£', 'NGN': '₦',
        'KES': 'KSh', 'GHS': '₵', 'UAH': '₴', 'KZT': '₸', 'UZS': "so'm", 'AZN': '₼',
        'GEL': '₾', 'AMD': '֏', 'BYN': 'Br', 'MDL': 'L', 'RON': 'lei', 'BGN': 'лв',
        'RSD': 'дин.', 'HRK': 'kn', 'CZK': 'Kč', 'HUF': 'Ft', 'ISK': 'kr',
        'TWD': 'NT$', 'NZD': 'NZ$', 'FJD': 'FJ$'
    },
    
    // Generation types
    GENERATION_TYPES: {
        NON_API: ['command', 'first_message'],
        CONTINUE: 'continue',
        QUIET: 'quiet',
        IMPERSONATE: 'impersonate'
    },
    
    // Non-API message types to skip
    NON_API_MESSAGE_TYPES: ['command', 'first_message'],
    
    // Popup configuration
    POPUP: {
        WIDTH: 400,
        MAX_HEIGHT: '70vh',
        Z_INDEX: 99999
    }
};

const defaultSettings = {
    showInTopBar: true,
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Prices per 1M tokens: { "gpt-4o": { in: 2.5, out: 10 }, ... }
    modelPrices: {},
    // Selected currency
    currency: 'USD',
    // Accumulated usage data
    usage: {
        session: { input: 0, output: 0, total: 0, messageCount: 0, startTime: null },
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
        // Time-based buckets: { "2025-01-15": { input: X, output: Y, total: Z, models: { "gpt-4o": 500, ... } }, ... }
        byDay: {},
        byHour: {},    // "2025-01-15T14": { ... }
        byWeek: {},    // "2025-W03": { ... }
        byMonth: {},   // "2025-01": { ... }
        // Per-chat usage: { "chatId": { input: X, output: Y, ... }, ... }
        byChat: {},
        // Per-model usage: { "gpt-4o": { input: X, output: Y, total: Z, messageCount: N }, ... }
        byModel: {},
    },
};

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    // Deep merge defaults for any missing keys
    const settings = extension_settings[extensionName];
    if (!settings.modelColors) settings.modelColors = {};
    if (!settings.usage) settings.usage = structuredClone(defaultSettings.usage);
    if (!settings.usage.session) settings.usage.session = structuredClone(defaultSettings.usage.session);
    if (!settings.usage.allTime) settings.usage.allTime = structuredClone(defaultSettings.usage.allTime);
    if (!settings.usage.byDay) settings.usage.byDay = {};
    if (!settings.usage.byHour) settings.usage.byHour = {};
    if (!settings.usage.byWeek) settings.usage.byWeek = {};
    if (!settings.usage.byMonth) settings.usage.byMonth = {};
    if (!settings.usage.byChat) settings.usage.byChat = {};
    if (!settings.usage.byModel) settings.usage.byModel = {};

    // Initialize modelPrices
    if (!settings.modelPrices) settings.modelPrices = {};

    // Initialize currency
    if (!settings.currency) settings.currency = 'USD';

    // Migration: Convert byDay.models from numeric format to object format
    // Old: models[modelId] = totalTokens (number)
    // New: models[modelId] = { input, output, total }
    let migrationNeeded = false;
    for (const dayData of Object.values(settings.usage.byDay)) {
        if (dayData.models) {
            for (const [modelId, value] of Object.entries(dayData.models)) {
                if (typeof value === 'number') {
                    migrationNeeded = true;
                    // Migrate: estimate input/output using day's ratio
                    const ratio = dayData.total ? value / dayData.total : 0;
                    dayData.models[modelId] = {
                        input: Math.round((dayData.input || 0) * ratio),
                        output: Math.round((dayData.output || 0) * ratio),
                        total: value
                    };
                }
            }
        }
    }

    // Save migration changes to localStorage
    if (migrationNeeded) {
        saveSettings();
        console.log('[Token Usage Tracker] Migrated byDay.models to new format and saved');
    }

    // Initialize session start time
    if (!settings.usage.session.startTime) {
        settings.usage.session.startTime = new Date().toISOString();
    }

    return settings;
}

/**
 * Save settings with debounce
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get current settings
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * CurrencyService - handles currency rates loading, caching, and conversion
 */
class CurrencyService {
    constructor() {
        this.ratesCache = null;
        this.cacheDate = null;
    }

    /**
     * Load currency rates from API with in-memory caching
     * Rates are cached for 24 hours to avoid unnecessary requests
     * @returns {Promise<Object|null>} Currency rates object or null on error
     */
    async loadRates() {
        const today = new Date().toDateString();

        // Return cached rates if still valid (same day)
        if (this.ratesCache && this.cacheDate === today) {
            console.log('[Token Usage Tracker] Using cached currency rates');
            return this.ratesCache;
        }

        try {
            console.log('[Token Usage Tracker] Fetching currency rates from API...');
            const response = await fetch(CONFIG.CURRENCY_API_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();

            // Cache the rates and date
            this.ratesCache = data.usd || {};
            this.cacheDate = new Date().toDateString();

            console.log(`[Token Usage Tracker] Loaded ${Object.keys(this.ratesCache).length} currency rates`);
            return this.ratesCache;
        } catch (error) {
            console.error('[Token Usage Tracker] Error loading currency rates:', error);
            // Return cached rates even if expired, if available
            if (this.ratesCache) {
                console.log('[Token Usage Tracker] Using expired cached rates due to fetch error');
                return this.ratesCache;
            }
            return null;
        }
    }

    /**
     * Get available currencies from loaded rates
     * @returns {string[]} Array of currency codes
     */
    getAvailableCurrencies() {
        if (!this.ratesCache) return [];
        return Object.keys(this.ratesCache).sort();
    }

    /**
     * Check if rates are loaded
     * @returns {boolean} True if rates are available
     */
    isLoaded() {
        return this.ratesCache !== null;
    }

    /**
     * Convert USD amount to selected currency
     * @param {number} usdAmount - Amount in USD
     * @param {string} targetCurrency - Target currency code
     * @returns {number} Amount in target currency
     */
    convertToCurrency(usdAmount, targetCurrency) {
        if (targetCurrency === 'USD') return usdAmount;
        if (!this.ratesCache) return usdAmount;

        const rate = this.ratesCache[targetCurrency.toLowerCase()];
        if (!rate) {
            console.warn(`[Token Usage Tracker] No rate found for currency: ${targetCurrency}`);
            return usdAmount;
        }

        return usdAmount * rate;
    }

    /**
     * Format currency amount with appropriate symbol/notation
     * @param {number} amount - Amount
     * @param {string} currency - Currency code
     * @returns {string} Formatted string
     */
    format(amount, currency) {
        const symbol = CONFIG.CURRENCY_SYMBOLS[currency] || currency + ' ';
        const formatted = amount.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4
        });

        return symbol + formatted;
    }

    /**
     * Convert and format USD amount to target currency
     * @param {number} usdAmount - Amount in USD
     * @param {string} targetCurrency - Target currency code
     * @returns {string} Formatted string in target currency
     */
    convertAndFormat(usdAmount, targetCurrency) {
        const converted = this.convertToCurrency(usdAmount, targetCurrency);
        return this.format(converted, targetCurrency);
    }

    /**
     * Get exchange rate for display
     * @param {string} currency - Target currency
     * @returns {number} Exchange rate from USD
     */
    getRate(currency) {
        if (!this.ratesCache) return 1;
        return this.ratesCache[currency.toLowerCase()] || 1;
    }
}

// Create singleton instance
const currencyService = new CurrencyService();

/**
 * ErrorHandler - centralized error handling with logging and fallback values
 */
class ErrorHandler {
    /**
     * Handle an error with logging and optional fallback value
     * @param {string} context - Where the error occurred (e.g., 'counting tokens')
     * @param {Error} error - The error object
     * @param {*} fallbackValue - Optional fallback value to return
     * @returns {*} fallbackValue if provided, undefined otherwise
     */
    static handle(context, error, fallbackValue = undefined) {
        console.error(`[Token Usage Tracker] Error ${context}:`, error);
        return fallbackValue;
    }

    /**
     * Handle error with toast notification
     * @param {string} message - User-friendly error message
     * @param {Error} error - The error object
     */
    static notify(message, error) {
        console.error(`[Token Usage Tracker] ${message}:`, error);
        if (typeof toastr !== 'undefined') {
            toastr.error(message);
        }
    }

    /**
     * Silently handle error with logging only (no user notification)
     * @param {string} context - Where the error occurred
     * @param {Error} error - The error object
     * @param {*} fallbackValue - Optional fallback value
     * @returns {*} fallbackValue if provided, undefined otherwise
     */
    static silent(context, error, fallbackValue = undefined) {
        console.debug(`[Token Usage Tracker] ${context}:`, error?.message || error);
        return fallbackValue;
    }
}

// Legacy variables for backward compatibility
let currencyRatesCache = null;
let currencyCacheDate = null;

/**
 * Get the current day key (YYYY-MM-DD)
 */
function getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get the current hour key (YYYY-MM-DDTHH)
 */
function getHourKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}`;
}

/**
 * Get the current week key (YYYY-WNN)
 */
function getWeekKey(date = new Date()) {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((date.getTime() - startOfYear.getTime()) / CONFIG.MILLISECONDS_PER_DAY);
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the current month key (YYYY-MM)
 */
function getMonthKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * Count tokens using SillyTavern's native tokenizer
 * Uses getTextTokens for accurate IDs when available, falls back to getTokenCountAsync
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // Get the current tokenizer based on user settings and API
        const { tokenizerId } = getFriendlyTokenizerName(main_api);

        // Try to get actual token IDs first (more accurate)
        const tokenizerType = main_api === 'openai' ? tokenizers.OPENAI : tokenizerId;
        const tokenIds = getTextTokens(tokenizerType, text);

        if (Array.isArray(tokenIds) && tokenIds.length > 0) {
            return tokenIds.length;
        }

        // Fall back to async count (uses caching)
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / CONFIG.CHAR_PER_TOKEN_ESTIMATE);
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null) {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();
    const totalTokens = inputTokens + outputTokens;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
    };

    // Session
    addTokens(usage.session);

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, total: 0, messageCount: 0, models: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown for cost calculation)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, total: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
    }

    // By hour
    const hourKey = getHourKey(now);
    if (!usage.byHour[hourKey]) usage.byHour[hourKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byHour[hourKey]);

    // By week
    const weekKey = getWeekKey(now);
    if (!usage.byWeek[weekKey]) usage.byWeek[weekKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byWeek[weekKey]);

    // By month
    const monthKey = getMonthKey(now);
    if (!usage.byMonth[monthKey]) usage.byMonth[monthKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byMonth[monthKey]);

    // By chat
    if (chatId) {
        if (!usage.byChat[chatId]) usage.byChat[chatId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byChat[chatId]);
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    saveSettings();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'} (using ${getFriendlyTokenizerName(main_api).tokenizerName})`);
}

/**
 * Reset session usage
 */
function resetSession() {
    const settings = getSettings();
    settings.usage.session = {
        input: 0,
        output: 0,
        total: 0,
        messageCount: 0,
        startTime: new Date().toISOString(),
    };
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] Session reset');
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    const settings = getSettings();
    settings.usage = structuredClone(defaultSettings.usage);
    settings.usage.session.startTime = new Date().toISOString();
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    return {
        session: { ...usage.session },
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0, models: {} },
        thisHour: usage.byHour[getHourKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisWeek: usage.byWeek[getWeekKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisMonth: usage.byMonth[getMonthKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
        byHour: { ...usage.byHour },
        byWeek: { ...usage.byWeek },
        byMonth: { ...usage.byMonth },
        byChat: { ...usage.byChat },
        byModel: { ...usage.byModel },
    };
}

/**
 * Get usage for a specific time range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object} Aggregated usage for the range
 */
function getUsageForRange(startDate, endDate) {
    const settings = getSettings();
    const usage = settings.usage;

    const result = { input: 0, output: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Get usage for a specific chat
 * @param {string} chatId - Chat ID
 * @returns {Object} Usage for the chat
 */
function getChatUsage(chatId) {
    const settings = getSettings();
    return settings.usage.byChat[chatId] || { input: 0, output: 0, total: 0, messageCount: 0 };
}

/**
 * Pending state for token counting across async operations
 * Encapsulates state that was previously global variables
 */
class PendingTokenState {
    constructor() {
        this.inputTokensPromise = null;
        this.modelId = null;
        this.preContinueCount = 0;
        this.isPreContinueReady = false;
        this.isQuietGeneration = false;
        this.isImpersonateGeneration = false;
        this.isTrackingBackground = false;
    }

    /**
     * Reset all state to initial values
     */
    reset() {
        this.inputTokensPromise = null;
        this.modelId = null;
        this.preContinueCount = 0;
        this.isPreContinueReady = false;
        this.isQuietGeneration = false;
        this.isImpersonateGeneration = false;
        this.isTrackingBackground = false;
    }

    /**
     * Reset specifically for continue generation state
     */
    resetContinueState() {
        this.preContinueCount = 0;
        this.isPreContinueReady = false;
    }
}

const pendingState = new PendingTokenState();

/**
 * Count input tokens from the full prompt context (async helper)
 * @param {object} generate_data - The generation data containing the full prompt
 * @returns {Promise<number>} Total input token count
 */
async function countInputTokens(generate_data) {
    let inputTokens = 0;

    if (generate_data.prompt) {
        // For text completion APIs (kobold, novel, textgen) - prompt is a string
        if (typeof generate_data.prompt === 'string') {
            inputTokens = await countTokens(generate_data.prompt);
        }
        // For chat completion APIs (OpenAI) - prompt is an array of messages
        else if (Array.isArray(generate_data.prompt)) {
            for (const message of generate_data.prompt) {
                if (message.content) {
                    // Content can be a string or an array of content parts (for multimodal)
                    if (typeof message.content === 'string') {
                        inputTokens += await countTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        // Handle multimodal content (text + images)
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                inputTokens += await countTokens(part.text);
                            }
                            if (part.type === 'image_url' || part.type === 'image') {
                                // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                                // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                                inputTokens += CONFIG.IMAGE_TOKEN_ESTIMATE;
                            }
                        }
                    }
                }
                // Count role tokens (~1 token per role)
                if (message.role) {
                    inputTokens += 1;
                }
                // Count name field tokens (used in function calls, tool results, etc.)
                if (message.name) {
                    inputTokens += await countTokens(message.name);
                }
                // Count tool_calls tokens (Standard OpenAI)
                if (Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                inputTokens += await countTokens(toolCall.function.name);
                            }
                            if (toolCall.function.arguments) {
                                inputTokens += await countTokens(toolCall.function.arguments);
                            }
                        }
                    }
                }
                // Count invocations tokens (SillyTavern internal)
                if (Array.isArray(message.invocations)) {
                    for (const invocation of message.invocations) {
                        if (invocation.function) {
                            if (invocation.function.name) {
                                inputTokens += await countTokens(invocation.function.name);
                            }
                            if (invocation.function.arguments) {
                                inputTokens += await countTokens(invocation.function.arguments);
                            }
                        }
                    }
                }
                // Count deprecated function_call tokens
                if (message.function_call) {
                    if (message.function_call.name) {
                        inputTokens += await countTokens(message.function_call.name);
                    }
                    if (message.function_call.arguments) {
                        inputTokens += await countTokens(message.function_call.arguments);
                    }
                }
            }
            // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
            inputTokens += generate_data.prompt.length * CONFIG.MESSAGE_OVERHEAD_TOKENS;
        }
    }

    return inputTokens;
}

/**
 * Handle GENERATE_AFTER_DATA event - start counting input tokens (non-blocking)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    // Capture model ID synchronously (fast)
    pendingState.modelId = getGeneratingModel();

    // Start token counting but DON'T await - let it run in parallel with the API request
    pendingState.inputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${pendingState.modelId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
async function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Track the generation type for special handling
    pendingState.isQuietGeneration = (type === CONFIG.GENERATION_TYPES.QUIET);
    pendingState.isImpersonateGeneration = (type === CONFIG.GENERATION_TYPES.IMPERSONATE);

    // Reset pre-continue state
    pendingState.preContinueCount = 0;
    pendingState.isPreContinueReady = false;

    // For continue type, capture the current message's token count
    if (type === CONFIG.GENERATION_TYPES.CONTINUE) {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available (synchronous - preferred)
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    pendingState.preContinueCount = lastMessage.extra.token_count;
                    pendingState.isPreContinueReady = true;
                    console.log(`[Token Usage Tracker] Pre-continue tokens (cached): ${pendingState.preContinueCount}`);
                } else {
                    // Calculate it ourselves (async)
                    let tokens = await countTokens(lastMessage.mes || '');
                    if (lastMessage.extra?.reasoning) {
                        tokens += await countTokens(lastMessage.extra.reasoning);
                    }
                    pendingState.preContinueCount = tokens;
                    pendingState.isPreContinueReady = true;
                    console.log(`[Token Usage Tracker] Pre-continue tokens (counted): ${pendingState.preContinueCount}`);
                }
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            pendingState.preContinueCount = 0;
            pendingState.isPreContinueReady = true; // Mark as ready even on error to avoid blocking
        }
    } else {
        // Non-continue types don't need pre-continue state
        pendingState.isPreContinueReady = true;
    }
}

/**
 * Handle message received event - count output tokens and record
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning)
 * Falls back to manual counting if not available
 *
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
async function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    // These events are emitted for messages created without calling the API
    if (CONFIG.NON_API_MESSAGE_TYPES.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // If there's no pending token counting promise, this likely isn't a real API response
    // (e.g., could be a late-firing event after chat load)
    if (!pendingState.inputTokensPromise) {
        console.log(`[Token Usage Tracker] Skipping message with no pending token count (type: ${type || 'unknown'})`);
        return;
    }

    // For 'continue' type, wait for pre-continue token count to be ready
    // This prevents race condition where MESSAGE_RECEIVED fires before GENERATION_STARTED completes
    if (type === CONFIG.GENERATION_TYPES.CONTINUE && !pendingState.isPreContinueReady) {
        console.log('[Token Usage Tracker] Waiting for pre-continue tokens...');
        const maxWait = CONFIG.PRE_CONTINUE_MAX_WAIT_MS; // Max wait 5 seconds
        const waitInterval = CONFIG.PRE_CONTINUE_WAIT_INTERVAL_MS;
        let waited = 0;

        while (!pendingState.isPreContinueReady && waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, waitInterval));
            waited += waitInterval;
        }

        if (!pendingState.isPreContinueReady) {
            console.warn('[Token Usage Tracker] Timeout waiting for pre-continue tokens, proceeding without delta');
        } else {
            console.log(`[Token Usage Tracker] Pre-continue ready after ${waited}ms`);
        }
    }

    try {
        const context = getContext();
        const message = context.chat[messageIndex];

        if (!message || !message.mes) return;

        let outputTokens;

        // Use SillyTavern's pre-calculated token count if available
        // This already includes reasoning tokens when power_user.message_token_count_enabled is true
        if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
            outputTokens = message.extra.token_count;
            console.log(`[Token Usage Tracker] Using pre-calculated token count: ${outputTokens}`);
        } else {
            // Fall back to manual counting
            outputTokens = await countTokens(message.mes);

            // Also count reasoning/thinking tokens (from Claude thinking, OpenAI o1, etc.)
            if (message.extra?.reasoning) {
                const reasoningTokens = await countTokens(message.extra.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} reasoning tokens`);
            }
            console.log(`[Token Usage Tracker] Manually counted tokens: ${outputTokens}`);
        }

        // For 'continue' type, we only want the newly generated tokens, not the full message
        // Subtract the pre-continue token count to get just the delta
        if (type === CONFIG.GENERATION_TYPES.CONTINUE && pendingState.preContinueCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - pendingState.preContinueCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${pendingState.preContinueCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = pendingState.preContinueCount;
        pendingState.preContinueCount = 0;
        pendingState.isPreContinueReady = false;

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingState.inputTokensPromise;
        const modelId = pendingState.modelId;
        pendingState.inputTokensPromise = null;
        pendingState.modelId = null;

        // Get current chat ID if available
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${outputTokens} out, model: ${modelId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting output tokens:', error);
    }
}

/**
 * Handle generation stopped event - count tokens for cancelled/stopped generations
 * This ensures that input tokens (which were sent to the API) are still counted,
 * along with any partial output tokens that were generated before stopping.
 */
async function handleGenerationStopped() {
    // If there's no pending token counting promise, nothing to record
    if (!pendingState.inputTokensPromise) return;

    try {
        let outputTokens = 0;

        // Try to get partial output from the streaming processor
        if (streamingProcessor) {
            // Count main response text
            if (streamingProcessor.result) {
                outputTokens = await countTokens(streamingProcessor.result);
                console.log(`[Token Usage Tracker] Partial output from stopped generation: ${outputTokens} tokens`);
            }

            // Also count any reasoning tokens that were generated
            if (streamingProcessor.reasoningHandler?.reasoning) {
                const reasoningTokens = await countTokens(streamingProcessor.reasoningHandler.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} partial reasoning tokens`);
            }
        }

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingState.inputTokensPromise;
        const modelId = pendingState.modelId;
        pendingState.inputTokensPromise = null;
        pendingState.modelId = null;
        pendingState.resetContinueState();

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${inputTokens} in, ${outputTokens} out (partial), model: ${modelId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingState.inputTokensPromise = null;
        pendingState.resetContinueState();
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingState.reset();
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit(CONFIG.EVENTS.USAGE_UPDATED, getUsageStats());
}

/**
 * Handle impersonate ready event - count output tokens for impersonation
 * This fires when impersonation completes and puts text into the input field
 * @param {string} text - The generated impersonation text
 */
async function handleImpersonateReady(text) {
    if (!pendingState.inputTokensPromise) return;

    try {
        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingState.inputTokensPromise;
        const modelId = pendingState.modelId;
        pendingState.inputTokensPromise = null;
        pendingState.modelId = null;
        pendingState.resetContinueState();

        // Count output tokens from the impersonated text
        let outputTokens = 0;
        if (text && typeof text === 'string') {
            outputTokens = await countTokens(text);
        }

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);


        // Reset impersonate state
        pendingState.isImpersonateGeneration = false;
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling impersonate ready:', error);
        pendingState.inputTokensPromise = null;
        pendingState.modelId = null;
        pendingState.resetContinueState();
        pendingState.isImpersonateGeneration = false;
    }
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenusage',
        callback: async () => {
            const stats = getUsageStats();
            const output = [
                `Tokenizer: ${stats.tokenizer}`,
                `Session: ${stats.session.total} tokens (${stats.session.input} in, ${stats.session.output} out)`,
                `Today: ${stats.today.total} tokens`,
                `This Week: ${stats.thisWeek.total} tokens`,
                `This Month: ${stats.thisMonth.total} tokens`,
                `All Time: ${stats.allTime.total} tokens`,
            ].join('\n');
            return output;
        },
        returns: 'Token usage statistics',
        helpString: 'Displays current token usage statistics across different time periods.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenreset',
        callback: async (args) => {
            const scope = String(args || '').trim() || 'session';
            if (scope === 'all') {
                resetAllUsage();
                return 'All token usage data has been reset.';
            } else {
                resetSession();
                return 'Session token usage has been reset.';
            }
        },
        returns: 'Confirmation message',
        helpString: 'Resets token usage. Use /tokenreset for session only, or /tokenreset all for all data.',
    }));
}

/**
 * Public API exposed for frontend/UI components
 */
window['TokenUsageTracker'] = {
    getStats: getUsageStats,
    getUsageForRange,
    getChatUsage,
    resetSession,
    resetAllUsage,
    recordUsage,
    countTokens, // Expose the token counting function
    // Subscribe to updates
    onUpdate: (callback) => {
        eventSource.on('tokenUsageUpdated', callback);
    },
    // Unsubscribe from updates
    offUpdate: (callback) => {
        eventSource.removeListener('tokenUsageUpdated', callback);
    },
};

/**
 * Format token count with K/M suffix
 */
function formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

/**
 * Format number with commas
 */
function formatNumberFull(num) {
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Generate a random color using HSL for guaranteed distinctness
 * Colors are persisted once assigned to maintain consistency
 * @param {string} modelId - Model identifier
 * @returns {string} Hex color code
 */
function getModelColor(modelId) {
    const settings = getSettings();

    // Return persisted color if exists
    if (settings.modelColors[modelId]) {
        return settings.modelColors[modelId];
    }

    // Get all existing assigned colors to avoid duplicates
    const existingColors = Object.values(settings.modelColors);

    // Generate a random color that's distinct from existing ones
    let newColor;
    let attempts = 0;
    do {
        // Random hue (0-360), high saturation (60-80%), medium lightness (45-65%)
        const hue = Math.floor(Math.random() * 360);
        const sat = 60 + Math.floor(Math.random() * 20);
        const light = 45 + Math.floor(Math.random() * 20);
        newColor = hslToHex(hue, sat, light);
        attempts++;
    } while (attempts < 50 && isTooSimilar(newColor, existingColors));

    // Persist the new color
    settings.modelColors[modelId] = newColor;
    saveSettings();

    return newColor;
}

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Check if a color is too similar to any existing colors
 */
function isTooSimilar(newColor, existingColors) {
    for (const existing of existingColors) {
        if (colorDistance(newColor, existing) < 50) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate color distance (simple RGB euclidean)
 */
function colorDistance(c1, c2) {
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Set color for a model
 * @param {string} modelId - Model identifier
 * @param {string} color - Hex color code
 */
function setModelColor(modelId, color) {
    const settings = getSettings();
    settings.modelColors[modelId] = color;
    saveSettings();
}

/**
 * Get price settings for a model
 * @param {string} modelId
 * @returns {{in: number, out: number}} Price per 1M tokens
 */
function getModelPrice(modelId) {
    const settings = getSettings();
    return settings.modelPrices[modelId] || { in: 0, out: 0 };
}

/**
 * Set price settings for a model
 * @param {string} modelId
 * @param {number} priceIn - Price per 1M input tokens
 * @param {number} priceOut - Price per 1M output tokens
 */
function setModelPrice(modelId, priceIn, priceOut) {
    const settings = getSettings();
    settings.modelPrices[modelId] = {
        in: parseFloat(priceIn) || 0,
        out: parseFloat(priceOut) || 0
    };
    saveSettings();
}

/**
 * Calculate cost for a given token usage and model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens, modelId) {
    const prices = getModelPrice(modelId);
    if (!prices.in && !prices.out) return 0;

    const inputCost = (inputTokens / 1000000) * prices.in;
    const outputCost = (outputTokens / 1000000) * prices.out;
    return inputCost + outputCost;
}

/**
 * Calculate all-time cost using the byModel aggregation which has precise input/output counts
 */
function calculateAllTimeCost() {
    const settings = getSettings();
    const byModel = settings.usage.byModel;
    let totalCost = 0;

    for (const [modelId, data] of Object.entries(byModel)) {
        totalCost += calculateCost(data.input, data.output, modelId);
    }
    return totalCost;
}

// Chart state
let currentChartRange = CONFIG.CHART_RANGES.MEDIUM;
let chartData = [];
let tooltip = null;

// Chart colors - adapted for dark theme
const CHART_COLORS = CONFIG.CHART_COLORS;

const SVG_NS = "http://www.w3.org/2000/svg";

function createSVGElement(type, attrs = {}) {
    const el = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

/**
 * Get chart data from real usage stats
 */
function getChartData(days) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, models: {} };

        data.push({
            date: date,
            dayKey: dayKey,
            usage: dayData.total || 0,
            input: dayData.input || 0,
            output: dayData.output || 0,
            models: dayData.models || {},
            displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date)
        });
    }
    return data;
}

/**
 * Render the bar chart
 */
function renderChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = CONFIG.CHART_MARGIN;
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;'
    });


    const cursorGroup = createSVGElement('g', { class: 'cursors' });
    const gridGroup = createSVGElement('g', { class: 'grid' });
    const barGroup = createSVGElement('g', { class: 'bars' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(cursorGroup);
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif'
        });
        text.textContent = formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > CONFIG.CHART_BAR_MAX_WIDTH) barWidth = CONFIG.CHART_BAR_MAX_WIDTH;
    const actualGap = totalBarWidth - barWidth;
    const labelInterval = CONFIG.CHART_LABEL_INTERVAL[currentChartRange] || 3;

    chartData.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (actualGap / 2);
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Hover area
        const cursor = createSVGElement('rect', {
            x: slotX,
            y: margin.top,
            width: totalBarWidth,
            height: chartHeight,
            fill: 'transparent',
            opacity: '0.1',
            class: 'cursor-rect',
            style: 'cursor: pointer;'
        });

        cursor.addEventListener('mouseenter', async () => {
            cursor.setAttribute('fill', CHART_COLORS.cursor);
            showTooltip(d);
        });
        cursor.addEventListener('mousemove', (e) => {
            moveTooltip(e);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);
        const w = barWidth;

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${w} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        if (d.models && Object.keys(d.models).length > 0 && d.usage > 0) {
            // Extract total from new object format or use number directly for legacy
            const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
            const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1])); // Sort by usage desc

            let cumulativeY = barY + h; // Start from bottom

            for (const [modelId, modelData] of modelEntries) {
                const tokens = getTokens(modelData);
                const segmentHeight = (tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const color = getModelColor(modelId);
                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: '1',
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none'
                });
                barGroup.appendChild(segment);

                cumulativeY = segmentY;
            }
        }

        // Draw outer bar border (on top of segments)
        const outerPath = createSVGElement('path', {
            d: outerPathD,
            fill: 'none',
            stroke: CHART_COLORS.bar,
            'stroke-width': '1.5',
            'shape-rendering': 'geometricPrecision',
            'pointer-events': 'none'
        });
        barGroup.appendChild(outerPath);


        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': '10',
                'font-family': 'ui-sans-serif, system-ui, sans-serif'
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    container.appendChild(svg);
}

function showTooltip(d) {
    if (!tooltip) return;

    // Build model breakdown HTML
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        // Extract total from new object format or use number directly for legacy
        const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
        const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(a[1]) - getTokens(b[1])); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        for (const [model, modelData] of displayEntries) {
            const tokens = getTokens(modelData);
            const percent = d.usage > 0 ? Math.round((tokens / d.usage) * 100) : 0;
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatTokens(tokens)} (${percent}%)</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    // Calculate cost for this day
    let dayCost = 0;
    const dayModelIds = [];
    if (d.models) {
        for (const [mid, modelData] of Object.entries(d.models)) {
            const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
            const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
            dayCost += calculateCost(mInput, mOutput, mid);
            dayModelIds.push(mid);
        }
    }

    const settings = getSettings();
    const selectedCurrency = settings.currency || 'USD';
    // Check if ALL models used today have prices set
    const dayModelsHavePrice = dayModelIds.length > 0 && dayModelIds.every(modelId => {
        return settings.modelPrices[modelId] !== undefined;
    });
    const costDisplay = !dayModelsHavePrice ? 'Set model prices' : (dayCost > 0 ? currencyService.convertAndFormat(dayCost, selectedCurrency) : currencyService.format(0, selectedCurrency));

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} tokens</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.input)} in / ${formatNumberFull(d.output)} out</div>
        <div style="font-size: 10px; color: ${!dayModelsHavePrice ? '#fbbf24' : '#4ade80'};">Cost: ${costDisplay}</div>
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

function moveTooltip(e) {
    if (!tooltip) return;

    const tooltipWidth = tooltip.offsetWidth || 150;
    const tooltipHeight = tooltip.offsetHeight || 60;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = e.clientX + 15;
    let y = e.clientY - 10;

    // Keep tooltip within viewport
    if (x + tooltipWidth > viewportWidth - 10) {
        x = e.clientX - tooltipWidth - 15;
    }
    if (y + tooltipHeight > viewportHeight - 10) {
        y = viewportHeight - tooltipHeight - 10;
    }
    if (y < 10) {
        y = 10;
    }
    if (x < 10) {
        x = 10;
    }

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartData(range);
    renderChart();

    document.querySelectorAll(`.${CONFIG.CLASSES.RANGE_BUTTON}`).forEach(btn => {
        const val = parseInt(btn.getAttribute('data-value'));
        if (val === range) {
            btn.classList.add(CONFIG.CLASSES.ACTIVE_BUTTON);
        } else {
            btn.classList.remove(CONFIG.CLASSES.ACTIVE_BUTTON);
        }
    });
}

/**
 * Update the stats display in the UI
 */
function updateUIStats() {
    const stats = getUsageStats();
    const now = new Date();
    const settings = getSettings();
    const selectedCurrency = settings.currency || 'USD';

    // Today header
    $('#token-usage-today-total').text(formatTokens(stats.today.total));
    $('#token-usage-today-in').text(formatTokens(stats.today.input || 0));
    $('#token-usage-today-out').text(formatTokens(stats.today.output || 0));

    // Stats grid
    $('#token-usage-week-total').text(formatTokens(stats.thisWeek.total));
    $('#token-usage-month-total').text(formatTokens(stats.thisMonth.total));
    $('#token-usage-alltime-total').text(formatTokens(stats.allTime.total));

    // Check if any model used has prices set (for All Time)
    const allTimeModels = Object.keys(settings.usage.byModel || {});
    const allModelsHavePrice = allTimeModels.length > 0 && allTimeModels.every(modelId => {
        return settings.modelPrices[modelId] !== undefined;
    });

    // Cost calculations
    const allTimeCost = calculateAllTimeCost();
    const convertedAllTimeCost = currencyService.convertToCurrency(allTimeCost, selectedCurrency);

    if (!allModelsHavePrice) {
        $('#token-usage-alltime-cost').text('Set model prices');
    } else if (convertedAllTimeCost > 0) {
        $('#token-usage-alltime-cost').text(currencyService.format(convertedAllTimeCost, selectedCurrency));
    } else {
        $('#token-usage-alltime-cost').text(currencyService.format(0, selectedCurrency));
    }

    // For Week/Month/Today: Calculate from byDay data
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const todayKey = getDayKey(now);

    let weekCost = 0;
    let monthCost = 0;
    let todayCost = 0;
    let weekModels = [];
    let monthModels = [];
    let todayModels = [];

    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        // Parse dayKey (YYYY-MM-DD) as local date, not UTC
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        // Collect models for each period
        if (data.models) {
            const modelIds = Object.keys(data.models);
            if (getWeekKey(date) === currentWeekKey) {
                weekModels = weekModels.concat(modelIds);
            }
            if (getMonthKey(date) === currentMonthKey) {
                monthModels = monthModels.concat(modelIds);
            }
            if (dayKey === todayKey) {
                todayModels = todayModels.concat(modelIds);
            }
        }

        // Calculate cost for this day using per-model input/output breakdown
        let dayCost = 0;
        if (data.models) {
            for (const [mid, modelData] of Object.entries(data.models)) {
                const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                dayCost += calculateCost(mInput, mOutput, mid);
            }
        }

        // Week check
        if (getWeekKey(date) === currentWeekKey) {
            weekCost += dayCost;
            if (dayKey === todayKey) {
                todayCost += dayCost;
            }
        }
        // Month check
        if (getMonthKey(date) === currentMonthKey) {
            monthCost += dayCost;
        }
    }

    // Remove duplicates
    weekModels = [...new Set(weekModels)];
    monthModels = [...new Set(monthModels)];
    todayModels = [...new Set(todayModels)];

    // Check if models in each period have prices set
    const weekModelsHavePrice = weekModels.length > 0 && weekModels.every(modelId => {
        return settings.modelPrices[modelId] !== undefined;
    });
    const monthModelsHavePrice = monthModels.length > 0 && monthModels.every(modelId => {
        return settings.modelPrices[modelId] !== undefined;
    });
    const todayModelsHavePrice = todayModels.length > 0 && todayModels.every(modelId => {
        return settings.modelPrices[modelId] !== undefined;
    });

    if (!weekModelsHavePrice) {
        $('#token-usage-week-cost').text('Set model prices');
    } else {
        $('#token-usage-week-cost').text(currencyService.convertAndFormat(weekCost, selectedCurrency));
    }

    if (!monthModelsHavePrice) {
        $('#token-usage-month-cost').text('Set model prices');
    } else {
        $('#token-usage-month-cost').text(currencyService.convertAndFormat(monthCost, selectedCurrency));
    }

    if (!todayModelsHavePrice) {
        $('#token-usage-today-cost').text('Set model prices');
    } else {
        $('#token-usage-today-cost').text(currencyService.convertAndFormat(todayCost, selectedCurrency));
    }

    $('#token-usage-tokenizer').text('Tokenizer: ' + (stats.tokenizer || 'Unknown'));

    // Update chart data
    chartData = getChartData(currentChartRange);
    renderChart();

    // Update model colors grid
    renderModelColorsGrid();
}


/**
 * Create a model configuration row element with color picker and price inputs
 * @param {string} model - Model identifier
 * @returns {jQuery} jQuery-wrapped row element
 */
function createModelConfigRow(model) {
    const color = getModelColor(model);
    const prices = getModelPrice(model);

    const row = $(`
        <div class="model-config-row">
            <input type="color" value="${color}" data-model="${model}"
                   class="model-color-picker tu-color-picker">
            <span title="${model}" class="tu-text-base tu-text-body tu-truncate tu-flex-1">${model}</span>
            <span class="tu-text-xs tu-text-body tu-opacity-50 tu-flex-shrink-0">Price</span>
            <input type="number" class="price-input-in tu-price-input" data-model="${model}" value="${prices.in || ''}" step="0.01" min="0" placeholder="In" title="Price per 1M input tokens">
            <input type="number" class="price-input-out tu-price-input" data-model="${model}" value="${prices.out || ''}" step="0.01" min="0" placeholder="Out" title="Price per 1M output tokens">
        </div>
    `);

    // Color picker handler
    row.find('.model-color-picker').on('change', function() {
        setModelColor(String($(this).data('model')), String($(this).val()));
        renderChart();
    });

    // Price input handlers with debounce
    let debounceTimer;
    const handlePriceChange = () => {
        const mId = model;
        const pIn = row.find('.price-input-in').val();
        const pOut = row.find('.price-input-out').val();
        setModelPrice(mId, pIn, pOut);
        updateUIStats();
    };

    row.find('input[type="number"]').on('input', function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handlePriceChange, CONFIG.DEBOUNCE_DELAY_MS);
    });

    return row;
}

/**
 * Render the model colors grid with price inputs
 * Uses DocumentFragment for optimized DOM operations
 */
function renderModelColorsGrid() {
    const grid = $('#token-usage-model-colors-grid');
    if (grid.length === 0) return;

    const stats = getUsageStats();
    const models = Object.keys(stats.byModel || {}).sort();

    if (models.length === 0) {
        grid.empty().append('<div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.5; padding: 8px; text-align: center;">No models tracked yet</div>');
        return;
    }

    // If grid is already populated with the same models, don't wipe it (prevents input focus loss)
    const existingRows = grid.children(`.${CONFIG.CLASSES.MODEL_CONFIG_ROW}`);
    if (existingRows.length === models.length) {
        // Check if models are the same
        const existingModels = Array.from(existingRows).map(row => $(row).find('.model-color-picker').data('model'));
        const modelsUnchanged = existingModels.length === models.length &&
                               existingModels.every((m, i) => m === models[i]);
        if (modelsUnchanged) {
            return;
        }
    }

    // Use DocumentFragment for efficient batch DOM insertion
    const fragment = document.createDocumentFragment();
    grid.empty();

    for (const model of models) {
        const row = createModelConfigRow(model);
        // Append the DOM element from jQuery wrapper
        fragment.appendChild(row[0]);
    }

    grid[0].appendChild(fragment);
}

/**
 * Create the settings UI in the extensions panel
 */
function createSettingsUI() {
    const settings = getSettings();
    const stats = getUsageStats();

    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Chart Header: Today stats + Range selector -->
                    <div class="tu-flex-between" style="margin-bottom: 8px;">
                        <div>
                            <div class="tu-flex-start">
                                <span class="tu-text-3xl tu-font-semibold tu-text-body" id="token-usage-today-total">${formatTokens(stats.today.total)}</span>
                                <span id="token-usage-today-cost" class="tu-text-xl tu-text-body tu-opacity-80">$0.00</span>
                                <span class="tu-text-lg tu-text-body tu-opacity-50"> today</span>
                            </div>
                            <div class="tu-text-sm tu-text-body tu-opacity-50">
                                <span id="token-usage-today-in">${formatTokens(stats.today.input || 0)}</span> in /
                                <span id="token-usage-today-out">${formatTokens(stats.today.output || 0)}</span> out
                            </div>
                        </div>
                        <div class="tu-range-buttons">
                            <button class="token-usage-range-btn menu_button" data-value="7">7D</button>
                            <button class="token-usage-range-btn menu_button active" data-value="30">30D</button>
                            <button class="token-usage-range-btn menu_button" data-value="90">90D</button>
                        </div>
                    </div>

                    <!-- Chart -->
                    <div id="token-usage-chart"></div>

                    <!-- Stats Grid (Week, Month, All Time) -->
                    <div class="tu-stats-grid">
                        <div class="tu-stat-card" id="token-usage-week-card">
                            <div class="tu-p-4 tu-px-8">
                                <div class="tu-text-sm tu-text-body tu-opacity-50" style="text-decoration: underline;">This Week</div>
                                <div class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-week-total">${formatTokens(stats.thisWeek.total)}</div>
                            </div>
                            <div class="tu-border"></div>
                            <div class="tu-flex-1 tu-flex-center tu-p-4 tu-px-8">
                                <span class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-week-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="tu-stat-card" id="token-usage-month-card">
                            <div class="tu-p-4 tu-px-8">
                                <div class="tu-text-sm tu-text-body tu-opacity-50" style="text-decoration: underline;">This Month</div>
                                <div class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-month-total">${formatTokens(stats.thisMonth.total)}</div>
                            </div>
                            <div class="tu-border"></div>
                            <div class="tu-flex-1 tu-flex-center tu-p-4 tu-px-8">
                                <span class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-month-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="tu-stat-card" id="token-usage-alltime-card">
                            <div class="tu-p-4 tu-px-8">
                                <div class="tu-text-sm tu-text-body tu-opacity-50" style="text-decoration: underline;">All Time</div>
                                <div class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-alltime-total">${formatTokens(stats.allTime.total)}</div>
                            </div>
                            <div class="tu-border"></div>
                            <div class="tu-flex-1 tu-flex-center tu-p-4 tu-px-8">
                                <span class="tu-text-2xl tu-font-semibold tu-text-body" id="token-usage-alltime-cost">$0.00</span>
                            </div>
                        </div>
                    </div>

                    <!-- Config (Model Colors & Prices) -->
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <span class="tu-text-lg">Config</span>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content">
                            <div id="token-usage-model-colors-grid" class="tu-stats-grid"></div>
                        </div>
                    </div>

                    <!-- Controls -->
                    <div class="tu-flex tu-flex-center tu-gap-8" style="padding-left: 8px;">
                        <div class="tu-text-sm tu-text-body tu-opacity-40" id="token-usage-tokenizer">Tokenizer: ${stats.tokenizer || 'Unknown'}</div>
                        <div class="tu-flex-1"></div>
                        <label class="tu-flex tu-flex-center tu-gap-4 tu-text-base tu-text-body tu-opacity-70 tu-cursor-pointer">
                            <input type="checkbox" id="token-usage-currency-toggle" class="tu-cursor-pointer">
                            Select currency
                        </label>
                        <div class="tu-flex-1"></div>
                        <div id="token-usage-reset-all" class="menu_button" title="Reset all stats">
                            <i class="fa-solid fa-trash"></i>&nbsp;<span class="tu-text-lg">Reset All</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const targetContainer = $('#extensions_settings2');
    if (targetContainer.length > 0) {
        targetContainer.append(html);
        console.log('[Token Usage Tracker] UI appended to extensions_settings2');
    } else {
        const fallback = $('#extensions_settings');
        if (fallback.length > 0) {
            fallback.append(html);
            console.log('[Token Usage Tracker] UI appended to extensions_settings (fallback)');
        }
    }

    // Create tooltip element and append to body (not inside extension container to avoid layout issues)
    if (!document.getElementById('token-usage-tooltip')) {
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.className = 'tu-tooltip';
        document.body.appendChild(tooltipEl);
        console.log('[Token Usage Tracker] Tooltip appended to body');
    }
    tooltip = document.getElementById('token-usage-tooltip');

    // Initialize chart
    chartData = getChartData(currentChartRange);
    setTimeout(renderChart, 100);

    // Range button handlers
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
        });
    });

    $('#token-usage-reset-all').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Remove existing dialog if any
        const existingDialog = document.getElementById('token-usage-reset-dialog');
        if (existingDialog) {
            existingDialog.remove();
        }
        
        // Create custom dialog with checkbox (similar to week details popup)
        const dialogHtml = `
            <div id="token-usage-reset-dialog" style="position: absolute; top: 150px; right: 50%; transform: translateX(50%); background: #1a1a1a !important; background-color: #1a1a1a !important; border: 2px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 0; width: 400px; max-height: 70vh; overflow-y: auto; z-index: 99999; box-shadow: 0 4px 20px rgba(0,0,0,0.8);" id="token-usage-reset-dialog">
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #2a2a2a !important; background-color: #2a2a2a !important; border-radius: 8px 8px 0 0; cursor: move;" id="token-usage-reset-dialog-header">
                    <h3 style="margin: 0; color: var(--SmartThemeBodyColor); font-size: 14px;">⚠️ Reset Token Usage Data</h3>
                    <button onclick="document.getElementById('token-usage-reset-dialog').remove()" style="background: transparent; border: none; color: var(--SmartThemeBodyColor); cursor: pointer; font-size: 16px; padding: 0 4px;">×</button>
                </div>
                <div style="padding: 16px; background: #1a1a1a !important; background-color: #1a1a1a !important;">
                    <p style="margin: 0 0 16px; color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 12px; line-height: 1.5;">
                        Choose what to reset:
                    </p>
                    <label style="display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; cursor: pointer;">
                        <input type="checkbox" id="token-usage-reset-all-data" style="width: 16px; height: 16px; margin-top: 2px; cursor: pointer;">
                        <span style="color: var(--SmartThemeBodyColor); font-size: 12px; line-height: 1.4;">
                            <strong>Delete everything</strong> (stats, model colors, prices, settings)<br>
                            <span style="opacity: 0.6; font-size: 11px;">Use this when uninstalling the extension</span>
                        </span>
                    </label>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="token-usage-reset-cancel" class="menu_button" style="padding: 8px 16px; border-radius: 4px; border: 1px solid var(--SmartThemeBorderColor); background: var(--SmartThemeInputColor); color: var(--SmartThemeBodyColor); cursor: pointer; font-size: 12px;">
                            Cancel
                        </button>
                        <button id="token-usage-reset-confirm" class="menu_button" style="padding: 8px 16px; border-radius: 4px; border: 1px solid #ef4444; background: #ef4444; color: white; cursor: pointer; font-size: 12px;">
                            Reset
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        $('body').append(dialogHtml);
        
        // Make dialog draggable (same as week details popup)
        const dialog = document.getElementById('token-usage-reset-dialog');
        const header = document.getElementById('token-usage-reset-dialog-header');
        
        // Prevent clicks on dialog from closing parent drawers
        dialog.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        dialog.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = dialog.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            dialog.style.left = `${initialLeft + dx}px`;
            dialog.style.top = `${initialTop + dy}px`;
            dialog.style.right = 'auto';
            dialog.style.transform = 'none';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Handle cancel
        $('#token-usage-reset-cancel').on('click', function() {
            dialog.remove();
        });
        
        // Handle confirm
        $('#token-usage-reset-confirm').on('click', function() {
            const deleteAll = $('#token-usage-reset-all-data').is(':checked');

            if (deleteAll) {
                // Delete from memory
                delete extension_settings[extensionName];
                
                // Use SillyTavern's save function to persist changes
                saveSettingsDebounced();
                
                toastr.success('Extension data completely removed');

                // Reload page to reflect changes
                setTimeout(() => {
                    location.reload();
                }, 1500);
            } else {
                // Reset only usage stats
                resetAllUsage();
                updateUIStats();
                toastr.success('Stats reset (settings preserved)');
            }

            dialog.remove();
        });
    });

    // Currency toggle checkbox handler
    const currencyToggle = document.getElementById('token-usage-currency-toggle');
    if (currencyToggle) {
        currencyToggle.checked = settings.currency !== 'USD';

        // If currency is already selected (not USD), load rates and show selector on page load
        if (settings.currency !== 'USD') {
            currencyService.loadRates().then(() => {
                showCurrencySelector();
            });
        }

        currencyToggle.addEventListener('change', async () => {
            console.log('[Token Usage Tracker] Currency toggle clicked:', currencyToggle.checked);

            if (currencyToggle.checked) {
                // Load currency rates if not already loaded
                if (!currencyService.isLoaded()) {
                    await currencyService.loadRates();
                }

                // Show currency selection UI
                await showCurrencySelector();
            } else {
                // Reset to USD
                settings.currency = 'USD';
                saveSettings();
                updateUIStats();
                console.log('[Token Usage Tracker] Currency reset to USD');
            }
        });
    }

    // Week details popup handler
    const weekCard = document.getElementById('token-usage-week-card');
    if (weekCard) {
        weekCard.addEventListener('click', () => {
            showWeekDetails();
        });
    }

    // Month details popup handler
    const monthCard = document.getElementById('token-usage-month-card');
    if (monthCard) {
        monthCard.addEventListener('click', () => {
            showMonthDetails();
        });
    }

    // All time details popup handler
    const alltimeCard = document.getElementById('token-usage-alltime-card');
    if (alltimeCard) {
        alltimeCard.addEventListener('click', () => {
            showAllTimeDetails();
        });
    }

    // Subscribe to updates
    eventSource.on('tokenUsageUpdated', () => {
        updateUIStats();
        // Refresh open detail popups
        refreshDetailPopups();
    });

    // Handle container resize with ResizeObserver (handles panel width changes)
    const chartContainer = document.getElementById('token-usage-chart');
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
        let lastWidth = 0;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                // Only re-render if width actually changed
                if (Math.abs(newWidth - lastWidth) > 5) {
                    lastWidth = newWidth;
                    renderChart();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }

    // Fallback: window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(renderChart, 100);
    });
    
    // Initialize UI stats
    updateUIStats();
}

/**
 * Refresh all open detail popups with latest data
 */
function refreshDetailPopups() {
    // Refresh week popup if open
    if (document.getElementById('week-details-popup')) {
        document.getElementById('week-details-popup').remove();
        showWeekDetails();
    }
    // Refresh month popup if open
    if (document.getElementById('month-details-popup')) {
        document.getElementById('month-details-popup').remove();
        showMonthDetails();
    }
    // Refresh all time popup if open
    if (document.getElementById('alltime-details-popup')) {
        document.getElementById('alltime-details-popup').remove();
        showAllTimeDetails();
    }
}

/**
 * Helper function to create popup content for period statistics
 * @param {string} popupId - ID for the popup element
 * @param {string} title - Popup title (e.g., "This Week Details")
 * @param {Object} modelData - Aggregated model data { modelId: { input, output, cost } }
 * @param {number} totalInput - Total input tokens
 * @param {number} totalOutput - Total output tokens
 * @param {number} totalCost - Total cost in USD
 * @param {string} emptyMessage - Message to show when no data
 * @param {string} position - Popup position: 'right' or 'left'
 */
function createPeriodPopup(popupId, title, modelData, totalInput, totalOutput, totalCost, emptyMessage, position = 'right') {
    const settings = getSettings();
    const selectedCurrency = settings.currency || 'USD';

    // Build model rows
    let modelRows = '';
    for (const [modelId, data] of Object.entries(modelData)) {
        const prices = settings.modelPrices[modelId];
        const hasPrice = prices !== undefined;
        const convertedCost = currencyService.convertToCurrency(data.cost, selectedCurrency);
        const modelTitle = modelId.length > 25 ? modelId.substring(0, 22) + '...' : modelId;

        if (!hasPrice) {
            modelRows += `
                <div class="tu-popup-model-row">
                    <div class="tu-text-body tu-truncate" title="${modelId}">${modelTitle}</div>
                    <div class="tu-text-body tu-text-center tu-opacity-80">${formatTokens(data.input)} in / ${formatTokens(data.output)} out</div>
                    <div class="tu-text-warning tu-text-right">Set model prices</div>
                </div>
            `;
        } else {
            modelRows += `
                <div class="tu-popup-model-row">
                    <div class="tu-text-body tu-truncate" title="${modelId}">${modelTitle}</div>
                    <div class="tu-text-body tu-text-center tu-opacity-80">${formatTokens(data.input)} in / ${formatTokens(data.output)} out</div>
                    <div class="tu-text-success tu-text-right">${currencyService.format(convertedCost, selectedCurrency)}</div>
                </div>
            `;
        }
    }

    if (modelRows === '') {
        modelRows = `<div class="tu-popup-empty">${emptyMessage}</div>`;
    }

    const totalConvertedCost = currencyService.convertToCurrency(totalCost, selectedCurrency);
    const rightPosition = position === 'left' ? '420px' : '20px';

    return `
        <div class="tu-popup" id="${popupId}" style="right: ${rightPosition};">
            <div class="tu-popup-header" id="${popupId}-header">
                <h3>📊 ${title}</h3>
                <button class="tu-popup-close-btn" onclick="document.getElementById('${popupId}').remove()">×</button>
            </div>
            <div class="tu-popup-content">
                <div class="tu-popup-header-grid">
                    <div class="tu-text-body">Model</div>
                    <div class="tu-text-body tu-text-center">Tokens</div>
                    <div class="tu-text-body tu-text-right">Cost</div>
                </div>

                ${modelRows}

                <div class="tu-popup-total-row">
                    <div class="tu-text-body">Total</div>
                    <div class="tu-text-body tu-text-center">${formatTokens(totalInput)} in / ${formatTokens(totalOutput)} out</div>
                    <div class="tu-text-success">${currencyService.format(totalConvertedCost, selectedCurrency)}</div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Make a popup element draggable
 * @param {string} popupId - ID of the popup element
 */
function makePopupDraggable(popupId) {
    const popup = document.getElementById(popupId);
    if (!popup) return;

    const header = document.getElementById(`${popupId}-header`);
    if (!header) return;

    // Prevent clicks on popup from closing parent drawers
    popup.addEventListener('click', (e) => e.stopPropagation());
    popup.addEventListener('mousedown', (e) => e.stopPropagation());

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = popup.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        popup.style.left = `${initialLeft + dx}px`;
        popup.style.top = `${initialTop + dy}px`;
        popup.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

/**
 * Show detailed statistics for current week in a popup
 */
function showWeekDetails() {
    const settings = getSettings();
    const now = new Date();
    const currentWeekKey = getWeekKey(now);
    const selectedCurrency = settings.currency || 'USD';

    // Get all days in current week
    const weekData = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (getWeekKey(date) === currentWeekKey) {
            // Aggregate by model
            if (data.models) {
                for (const [modelId, modelData] of Object.entries(data.models)) {
                    if (!weekData[modelId]) {
                        weekData[modelId] = { input: 0, output: 0, cost: 0 };
                    }
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    const modelCost = calculateCost(mInput, mOutput, modelId);

                    weekData[modelId].input += mInput;
                    weekData[modelId].output += mOutput;
                    weekData[modelId].cost += modelCost;

                    totalInput += mInput;
                    totalOutput += mOutput;
                    totalCost += modelCost;
                }
            }
        }
    }

    // Remove existing popup if any
    const existing = document.getElementById('week-details-popup');
    if (existing) existing.remove();

    const popupHtml = createPeriodPopup(
        'week-details-popup',
        'This Week Details',
        weekData,
        totalInput,
        totalOutput,
        totalCost,
        'No data for this week',
        'right'
    );

    document.body.insertAdjacentHTML('beforeend', popupHtml);
    makePopupDraggable('week-details-popup');
}

/**
 * Show detailed statistics for current month in a popup
 */
function showMonthDetails() {
    const settings = getSettings();
    const now = new Date();
    const currentMonthKey = getMonthKey(now);

    // Get all days in current month
    const monthData = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (getMonthKey(date) === currentMonthKey) {
            if (data.models) {
                for (const [modelId, modelData] of Object.entries(data.models)) {
                    if (!monthData[modelId]) {
                        monthData[modelId] = { input: 0, output: 0, cost: 0 };
                    }
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    const modelCost = calculateCost(mInput, mOutput, modelId);

                    monthData[modelId].input += mInput;
                    monthData[modelId].output += mOutput;
                    monthData[modelId].cost += modelCost;

                    totalInput += mInput;
                    totalOutput += mOutput;
                    totalCost += modelCost;
                }
            }
        }
    }

    // Remove existing popup if any
    const existing = document.getElementById('month-details-popup');
    if (existing) existing.remove();

    const popupHtml = createPeriodPopup(
        'month-details-popup',
        'This Month Details',
        monthData,
        totalInput,
        totalOutput,
        totalCost,
        'No data for this month',
        'left'
    );

    document.body.insertAdjacentHTML('beforeend', popupHtml);
    makePopupDraggable('month-details-popup');
}

/**
 * Show detailed statistics for all time in a popup
 */
function showAllTimeDetails() {
    const settings = getSettings();

    // Aggregate all data by model
    const allTimeData = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (const [modelId, data] of Object.entries(settings.usage.byModel)) {
        allTimeData[modelId] = {
            input: data.input || 0,
            output: data.output || 0,
            cost: calculateCost(data.input || 0, data.output || 0, modelId)
        };
        totalInput += data.input || 0;
        totalOutput += data.output || 0;
        totalCost += allTimeData[modelId].cost;
    }

    // Remove existing popup if any
    const existing = document.getElementById('alltime-details-popup');
    if (existing) existing.remove();

    const popupHtml = createPeriodPopup(
        'alltime-details-popup',
        'All Time Details',
        allTimeData,
        totalInput,
        totalOutput,
        totalCost,
        'No data yet',
        'right'
    );

    document.body.insertAdjacentHTML('beforeend', popupHtml);
    makePopupDraggable('alltime-details-popup');
}

/**
 * Currency map cache (loaded from Currency_map.json)
 */
let currencyMapCache = null;

/**
 * Load currency map from file
 * @returns {Promise<Object>} Currency map object
 */
async function loadCurrencyMap() {
    if (currencyMapCache) {
        return currencyMapCache;
    }
    
    try {
        // Load from extension root directory using absolute path
        const response = await fetch('/scripts/extensions/third-party/Extension-TokenUsage/Currency_map.json');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        currencyMapCache = await response.json();
        return currencyMapCache;
    } catch (error) {
        console.error('[Token Usage Tracker] Error loading currency map:', error);
        return {};
    }
}

/**
 * Show currency selector dropdown
 */
async function showCurrencySelector() {
    const settings = getSettings();
    const currencies = currencyService.getAvailableCurrencies();

    if (currencies.length === 0) {
        console.error('[Token Usage Tracker] No currencies available');
        toastr.error('Failed to load currency list');
        return;
    }

    // Load currency map for display names
    const currencyMap = await loadCurrencyMap();

    // Create or get existing selector container
    let selectorContainer = document.getElementById('token-usage-currency-selector');

    if (selectorContainer) {
        // Toggle visibility
        if (selectorContainer.style.display === 'none') {
            selectorContainer.style.display = 'flex';
            // Update selected value when reopening
            const select = selectorContainer.querySelector('select');
            if (select) {
                select.value = settings.currency;
            }
        } else {
            selectorContainer.style.display = 'none';
        }
        return;
    }

    selectorContainer = document.createElement('div');
    selectorContainer.id = 'token-usage-currency-selector';
    selectorContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        margin-top: 8px;
        background: var(--SmartThemeInputColor);
        border: 1px solid var(--SmartThemeBorderColor);
        border-radius: 6px;
    `;

    // Create label
    const label = document.createElement('span');
    label.textContent = 'Currency:';
    label.style.cssText = 'font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.8; white-space: nowrap;';

    // Create select dropdown
    const select = document.createElement('select');
    select.style.cssText = `
        padding: 4px 8px;
        font-size: 10px;
        border-radius: 4px;
        border: 1px solid var(--SmartThemeBorderColor);
        background: var(--SmartThemeInputColor);
        color: var(--SmartThemeBodyColor);
        max-width: 200px;
        cursor: pointer;
    `;

    // Popular currencies first, then alphabetical
    const popularCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RUB', 'KRW', 'INR', 'BRL', 'CAD', 'AUD', 'CHF', 'PLN', 'UAH', 'KZT'];
    const sortedCurrencies = [
        ...popularCurrencies.filter(c => currencies.includes(c.toLowerCase())),
        ...currencies.filter(c => !popularCurrencies.some(p => p.toLowerCase() === c)).sort()
    ];

    sortedCurrencies.forEach(currency => {
        const option = document.createElement('option');
        option.value = currency;
        // Use display name from currency map if available
        const displayName = currencyMap[currency.toLowerCase()] || currency;
        option.textContent = `${currency} - ${displayName}`;
        if (currency === settings.currency) {
            option.selected = true;
        }
        select.appendChild(option);
    });
    
    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'menu_button';
    saveBtn.style.cssText = `
        padding: 4px 12px;
        font-size: 10px;
        border-radius: 4px;
        background: var(--SmartThemeButtonColor);
        color: var(--SmartThemeBodyColor);
        border: 1px solid var(--SmartThemeBorderColor);
        cursor: pointer;
        white-space: nowrap;
    `;
    
    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.className = 'menu_button';
    closeBtn.style.cssText = `
        padding: 4px 10px;
        font-size: 12px;
        border-radius: 4px;
        background: var(--SmartThemeInputColor);
        color: var(--SmartThemeBodyColor);
        border: 1px solid var(--SmartThemeBorderColor);
        cursor: pointer;
        white-space: nowrap;
    `;
    
    // Save on button click
    saveBtn.addEventListener('click', () => {
        const selectedCurrency = select.value;
        settings.currency = selectedCurrency;
        saveSettings();
        updateUIStats();
        console.log(`[Token Usage Tracker] Currency set to ${selectedCurrency}`);
        toastr.success(`Currency changed to ${selectedCurrency}`);

        // Update rate display
        updateRateDisplay();
    });
    
    // Close on button click
    closeBtn.addEventListener('click', () => {
        selectorContainer.style.display = 'none';
    });
    
    // Update rate display when selection changes
    select.addEventListener('change', () => {
        updateRateDisplay();
    });
    
    /**
     * Update the exchange rate display
     */
    function updateRateDisplay() {
        const selectedCurrency = select.value;
        const rate = currencyService.getRate(selectedCurrency);

        let rateEl = selectorContainer.querySelector('.currency-rate-display');
        if (!rateEl) {
            rateEl = document.createElement('span');
            rateEl.className = 'currency-rate-display';
            rateEl.style.cssText = 'font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.6; white-space: nowrap; margin-left: 4px;';
            selectorContainer.appendChild(rateEl);
        }
        rateEl.textContent = `1 USD = ${rate} ${selectedCurrency}`;
    }
    
    // Assemble
    selectorContainer.appendChild(label);
    selectorContainer.appendChild(select);
    selectorContainer.appendChild(saveBtn);
    selectorContainer.appendChild(closeBtn);
    
    // Insert after currency toggle
    const currencyToggle = document.getElementById('token-usage-currency-toggle');
    if (currencyToggle) {
        const toggleLabel = currencyToggle.closest('label');
        if (toggleLabel) {
            toggleLabel.parentElement.insertBefore(selectorContainer, toggleLabel.nextSibling);
        }
    }
    
    // Show initial rate
    updateRateDisplay();
}

/**
 * Patch SillyTavern's background generation functions to track tokens
 * - generateQuiet / generate_quiet (Used by Summarize, generated prompts, etc.)
 * - ConnectionManagerRequestService.sendRequest (Used by extensions like Roadway)
 */
function patchBackgroundGenerations() {
    patchGenerateQuietPrompt();
    patchConnectionManager();
}

function patchGenerateQuietPrompt() {
    // For quiet generations (Guided Generations, Summarize, Expressions, etc.),
    // MESSAGE_RECEIVED doesn't fire. Flush pending tokens on next generation or chat change.
    eventSource.on(event_types.GENERATION_STARTED, async (type, params, dryRun) => {
        if (dryRun) return;
        if (pendingState.isQuietGeneration && pendingState.inputTokensPromise) {
            await flushQuietGeneration();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (pendingState.isQuietGeneration && pendingState.inputTokensPromise) {
            await flushQuietGeneration();
        }
    });
}

/**
 * Flush a pending quiet generation, recording tokens from what we have
 */
async function flushQuietGeneration() {
    if (!pendingState.inputTokensPromise) return;

    try {
        const inputTokens = await pendingState.inputTokensPromise;
        const modelId = pendingState.modelId;

        // Try to get output from streaming processor
        let outputTokens = 0;
        if (streamingProcessor?.result) {
            outputTokens = await countTokens(streamingProcessor.result);
        }

        // Record the usage
        if (inputTokens > 0 || outputTokens > 0) {
            recordUsage(inputTokens, outputTokens, null, modelId);
        }
    } catch (e) {
        console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
    } finally {
        // Reset state
        pendingState.reset();
    }
}

/**
 * Interval ID for ConnectionManager patch polling
 * Stored for cleanup on extension unload
 */
let connectionManagerPatchInterval = null;

function patchConnectionManager() {
    // Clear any existing interval first
    if (connectionManagerPatchInterval) {
        clearInterval(connectionManagerPatchInterval);
    }

    // Poll for ConnectionManagerRequestService (used by Roadway and similar extensions)
    connectionManagerPatchInterval = setInterval(() => {
        try {
            const context = getContext();
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(connectionManagerPatchInterval);
                connectionManagerPatchInterval = null;
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

            ServiceClass.sendRequest = async function(profileId, messages, maxTokens, custom, overridePayload) {
                if (pendingState.isTrackingBackground) {
                    return await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
                }

                let inputTokens = 0;
                const modelId = getGeneratingModel();

                try {
                    pendingState.isTrackingBackground = true;

                    try {
                        inputTokens = await countInputTokens({ prompt: messages });
                    } catch (e) {
                        ErrorHandler.silent('counting sendRequest input', e);
                    }

                    const result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);

                    try {
                        let outputTokens = 0;
                        if (result && typeof result.content === 'string') {
                            outputTokens = await countTokens(result.content);
                        } else if (typeof result === 'string') {
                            outputTokens = await countTokens(result);
                        }

                        if (outputTokens > 0 || inputTokens > 0) {
                            recordUsage(inputTokens, outputTokens, null, modelId);
                        }
                    } catch (e) {
                        ErrorHandler.silent('counting sendRequest output', e);
                    }

                    return result;
                } finally {
                    pendingState.isTrackingBackground = false;
                }
            };

            ServiceClass.sendRequest._isPatched = true;
            clearInterval(connectionManagerPatchInterval);
            connectionManagerPatchInterval = null;
        } catch (e) {
            ErrorHandler.handle('patching ConnectionManager', e);
        }
    }, 1000);

    // Stop polling after 30 seconds to prevent infinite resource usage
    setTimeout(() => {
        if (connectionManagerPatchInterval) {
            clearInterval(connectionManagerPatchInterval);
            connectionManagerPatchInterval = null;
            console.log('[Token Usage Tracker] Stopped ConnectionManager patching after timeout');
        }
    }, CONFIG.CONNECTION_MANAGER_PATCH_TIMEOUT_MS);
}

/**
 * Generic handler for background generations with recursion guard
 */
async function handleBackgroundGeneration(originalFn, context, args, inputCounter, outputCounter) {
    // Avoid double counting if one patched function calls another
    if (pendingState.isTrackingBackground) {
        return await originalFn.apply(context, args);
    }

    let result;
    let inputTokens = 0;
    const modelId = getGeneratingModel();

    try {
        pendingState.isTrackingBackground = true;

        // Count input tokens
        try {
            inputTokens = await inputCounter();
            console.log(`[Token Usage Tracker] Counting background input. Tokens: ${inputTokens}`);
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background input:', e);
        }

        // Execute original
        result = await originalFn.apply(context, args);

        // Count output tokens
        try {
            const outputTokens = await outputCounter(result);
            if (outputTokens > 0 || inputTokens > 0) {
                recordUsage(inputTokens, outputTokens, null, modelId);
                console.log(`[Token Usage Tracker] Background usage recorded: ${inputTokens} in, ${outputTokens} out`);
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background output:', e);
        }
    } finally {
        pendingState.isTrackingBackground = false;
    }

    return result;
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);

    // Log current tokenizer
    try {
        const { tokenizerName } = getFriendlyTokenizerName(main_api);
        console.log(`[Token Usage Tracker] Using tokenizer: ${tokenizerName}`);
    } catch (e) {
        console.log('[Token Usage Tracker] Tokenizer will be determined when API is connected');
    }

    console.log('[Token Usage Tracker] Use /tokenusage to see stats, /tokenreset to reset session');

    // Emit initial stats for any listening UI
    setTimeout(() => {
        eventSource.emit('tokenUsageUpdated', getUsageStats());
    }, 1000);
});
