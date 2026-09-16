-- MangaTaro (mangataro.org). A WordPress-backed reader: catalogue browsing is
-- a POST-only `wp-json` route, and the chapter list is gated behind a token
-- that has to be recomputed per hour — see `generate_token` below.

SOURCE = {
  id = "user.mangataro",
  name = "MangaTaro",
  lang = "en",
  base_url = "https://mangataro.org",
}

-- How many rows `wp-json/manga/v1/load` answers per page. Not documented
-- anywhere, only observed: a page shorter than this is the last one, and a
-- full one might not be, which is the standard `has_next_page` guess.
local PAGE_SIZE = 24

--[[ ------------------------------------------------------------- MD5 -----
The chapter list endpoint (`/auth/manga-chapters`) refuses any request whose
`_t` isn't `md5(timestamp .. "mng_ch_" .. <UTC "YYYYMMDDHH">):sub(1, 16)` —
read out of the site's own bundled JS. The sandbox has no crypto library (see
`sandbox.rs`), so this is a small pure-Lua MD5, using Lua 5.4's native 64-bit
bitwise operators masked down to 32 bits after every step. ]]

local K = {
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
}
local S = {
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
}

local function bnot32(x)
  return (~x) & 0xFFFFFFFF
end

local function rotl(x, n)
  x = x & 0xFFFFFFFF
  return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF
end

local function md5(message)
  local bitlen = #message * 8
  message = message .. "\128"
  while (#message % 64) ~= 56 do
    message = message .. "\0"
  end
  -- 64-bit little-endian length. Every token input here is a handful of
  -- bytes, so the high 32 bits are always zero.
  for i = 0, 7 do
    local shift = i * 8
    if shift < 32 then
      message = message .. string.char((bitlen >> shift) & 0xFF)
    else
      message = message .. "\0"
    end
  end

  local a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476

  for chunk = 1, #message, 64 do
    local M = {}
    for j = 0, 15 do
      local o = chunk + j * 4
      local b1, b2, b3, b4 = message:byte(o, o + 3)
      M[j] = b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)
    end

    local A, B, C, D = a0, b0, c0, d0
    for i = 0, 63 do
      local F, g
      if i < 16 then
        F = (B & C) | (bnot32(B) & D)
        g = i
      elseif i < 32 then
        F = (D & B) | (bnot32(D) & C)
        g = (5 * i + 1) % 16
      elseif i < 48 then
        F = B ~ C ~ D
        g = (3 * i + 5) % 16
      else
        F = C ~ (B | bnot32(D))
        g = (7 * i) % 16
      end
      F = (F + A + K[i + 1] + M[g]) & 0xFFFFFFFF
      A, D, C = D, C, B
      B = (B + rotl(F, S[i + 1])) & 0xFFFFFFFF
    end

    a0 = (a0 + A) & 0xFFFFFFFF
    b0 = (b0 + B) & 0xFFFFFFFF
    c0 = (c0 + C) & 0xFFFFFFFF
    d0 = (d0 + D) & 0xFFFFFFFF
  end

  local function le_hex(x)
    local out = {}
    for i = 0, 3 do
      out[#out + 1] = string.format("%02x", (x >> (i * 8)) & 0xFF)
    end
    return table.concat(out)
  end

  return le_hex(a0) .. le_hex(b0) .. le_hex(c0) .. le_hex(d0)
end

--[[ ---------------------------------------------------- token & dates ---
`mangalize.time.now()` is the only clock the sandbox exposes (no `os`), so
the UTC calendar breakdown the token needs is computed from the raw Unix
timestamp by hand — Howard Hinnant's days-from-civil algorithm, run backwards. ]]

local function utc_hour_string(unixtime)
  local days = unixtime // 86400
  local secs_of_day = unixtime % 86400
  local z = days + 719468
  local era = (z >= 0 and z or z - 146096) // 146097
  local doe = z - era * 146097 -- [0, 146096]
  local yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365 -- [0, 399]
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + yoe // 4 - yoe // 100) -- [0, 365]
  local mp = (5 * doy + 2) // 153 -- [0, 11]
  local d = doy - (153 * mp + 2) // 5 + 1 -- [1, 31]
  local m = (mp < 10) and (mp + 3) or (mp - 9) -- [1, 12]
  if m <= 2 then
    y = y + 1
  end
  return string.format("%04d%02d%02d%02d", y, m, d, secs_of_day // 3600)
end

local function generate_token()
  local timestamp = mangalize.time.now()
  local secret = "mng_ch_" .. utc_hour_string(timestamp)
  local token = md5(tostring(timestamp) .. secret):sub(1, 16)
  return token, timestamp
end

--[[ ------------------------------------------------------- catalogue ---- ]]

-- The id this source hands back everywhere is the URL slug (`shy` out of
-- `.../manga/shy`), not MangaTaro's own numeric post id: the slug is what
-- `manga_details`/`volumes`/`covers` need to rebuild the detail page URL,
-- while the numeric id only matters for one call (`/auth/manga-chapters`)
-- and is read off that same detail page when it's needed.
local function slug_of(url)
  return url:match("/manga/([^/]+)/?$")
end

-- `wp-json/manga/v1/load` backs Popular, Latest and the site's own search box
-- alike; only `sort` and `search` differ. Filtering by year/genre/type/status
-- is left off (empty JSON-encoded arrays) since nothing in `Source` asks for it.
local function browse(page, search, sort)
  local body = mangalize.json.encode({
    page = page,
    search = search or "",
    years = "[]",
    genres = "[]",
    types = "[]",
    statuses = "[]",
    sort = sort,
    genreMatchMode = "any",
  })
  local res = mangalize.http.post(SOURCE.base_url .. "/wp-json/manga/v1/load", body)
  local rows = mangalize.json.decode(res.body)

  local manga = {}
  for i, row in ipairs(rows) do
    manga[i] = { id = slug_of(row.url), title = row.title, cover_url = row.cover }
  end
  return { manga = manga, has_next_page = (#rows == PAGE_SIZE) }
end

function popular(page)
  return browse(page, "", "popular_desc")
end

function latest(page)
  return browse(page, "", "post_desc")
end

-- The catalogue's own `search` filter (used above by `browse`) ranks purely
-- on relevance to the *description*, so a query for "shy" surfaces any title
-- whose blurb happens to use the word before it surfaces the manga actually
-- named SHY. `/auth/search` is the site's quick-search box instead, and
-- ranks by title match — but it has no paging of its own, only a `limit`, so
-- a second page here is simply empty rather than faked by re-fetching a
-- larger `limit` and slicing it.
function search(query, page)
  if page > 1 then
    return { manga = {}, has_next_page = false }
  end

  local body = mangalize.json.encode({ query = query, limit = 30 })
  local res = mangalize.http.post(SOURCE.base_url .. "/auth/search", body)
  local data = mangalize.json.decode(res.body)
  if not data.success then
    error("search: " .. (data.message or "request refused"))
  end

  local manga = {}
  for i, row in ipairs(data.results) do
    manga[i] = { id = row.slug, title = row.title, cover_url = row.thumbnail }
  end
  return { manga = manga, has_next_page = false }
end

--[[ -------------------------------------------------------- detail page - ]]

local function fetch_detail_page(id)
  local res = mangalize.http.get(SOURCE.base_url .. "/manga/" .. id)
  return res.body
end

-- The page's own `ComicSeries` JSON-LD block, decoded. Used instead of
-- scraping the "Author & Artist" panel by hand: that panel's classes are
-- generic Tailwind utility classes reused all over the page, while this
-- block is a stable, structured summary the site maintains for SEO.
local function comic_series_ld(document)
  local scripts = mangalize.html.select(document, 'script[type="application/ld+json"]')
  for _, row in ipairs(scripts) do
    local ok, parsed = pcall(mangalize.json.decode, row.text)
    if ok and parsed["@type"] == "ComicSeries" then
      return parsed
    end
  end
  return {}
end

function manga_details(id)
  local document = fetch_detail_page(id)
  local ld = comic_series_ld(document)

  local title_rows = mangalize.html.select(document, "h1")
  local title = title_rows[1] and title_rows[1].text or ld.name

  local description_rows = mangalize.html.select(document, "#description-content-tab")
  local description = description_rows[1] and description_rows[1].text or ld.description

  local cover_rows = mangalize.html.select(document, 'meta[property="og:image"]')
  local cover_url = cover_rows[1] and cover_rows[1].attrs.content or ld.image

  -- The page lists "Author & Artist" as one combined credit; MangaTaro
  -- doesn't distinguish them, so both fields get the same name.
  local author = ld.author and ld.author.name or nil

  local seen, tags = {}, {}
  for _, row in ipairs(mangalize.html.select(document, 'a[href*="/tag/"]')) do
    if row.text ~= "" and not seen[row.text] then
      seen[row.text] = true
      tags[#tags + 1] = row.text
    end
  end

  return {
    title = title,
    author = author,
    artist = author,
    description = description,
    tags = tags,
    cover_url = cover_url,
  }
end

--[[ ------------------------------------------------------------ volumes - ]]

-- MangaTaro has no volume concept at all, only a flat chapter list, so every
-- chapter is reported under the library's own "Unsorted" bucket rather than
-- invented volume numbers.
local UNSORTED = "Unsorted"

function volumes(id, language)
  local document = fetch_detail_page(id)
  local id_rows = mangalize.html.select(document, "[data-manga-id]")
  if not id_rows[1] then
    error("could not find this manga's internal id on its page")
  end
  local manga_id = id_rows[1].attrs["data-manga-id"]

  local chapters = {}
  local offset = 0
  while true do
    local token, timestamp = generate_token()
    local url = SOURCE.base_url
      .. "/auth/manga-chapters?manga_id="
      .. manga_id
      .. "&offset="
      .. offset
      .. "&limit=500&order=ASC&_t="
      .. token
      .. "&_ts="
      .. timestamp
    local res = mangalize.http.get(url)
    local data = mangalize.json.decode(res.body)
    if not data.success then
      error("manga-chapters: " .. (data.message or "request refused"))
    end

    for _, row in ipairs(data.chapters) do
      chapters[#chapters + 1] = { number = row.chapter, id = row.id, unavailable = false }
    end

    offset = offset + #data.chapters
    if not data.has_more or #data.chapters == 0 then
      break
    end
  end

  return { { volume = UNSORTED, chapters = chapters } }
end

--[[ ------------------------------------------------------------- covers - ]]

-- The gallery on the detail page is MyAnimeList cover art, already inlined
-- into the initial HTML (`data-large-url`) rather than lazy-loaded, and isn't
-- tied to any one volume, so every entry is reported without a `volume`.
function covers(id)
  local document = fetch_detail_page(id)
  local results = {}
  for _, row in ipairs(mangalize.html.select(document, ".gallery-item")) do
    local url = row.attrs["data-large-url"]
    if url then
      results[#results + 1] = { url = url }
    end
  end
  return results
end

--[[ ---------------------------------------------------------- page_list - ]]

function page_list(chapter_id)
  local res = mangalize.http.get(SOURCE.base_url .. "/auth/chapter-content?chapter_id=" .. chapter_id)
  local data = mangalize.json.decode(res.body)
  if not data.success then
    error("chapter-content: " .. (data.message or "request refused"))
  end
  if data.chapter_type ~= "media" then
    return {} -- a text-only chapter has no page images to offer.
  end
  return data.images
end
