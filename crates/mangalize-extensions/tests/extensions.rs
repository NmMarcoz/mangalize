//! End-to-end proof that the host API is enough for a real, if small,
//! `ParsedHttpSource`-shaped site: a JSON catalogue plus an HTML reader page,
//! read entirely from a Lua script running through the sandbox.
//!
//! A real local `TcpListener` rather than a mock, same reasoning as
//! `mangalize-fetch/tests/fetch.rs`: what actually breaks a source script is
//! the HTTP layer (headers, status codes, real JSON/HTML bytes), not anything
//! a mock would exercise.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mangalize_extensions::lua::LuaSource;
use mangalize_extensions::Source;

/// Body for a path, or `None` for 404. `id` is always `"1"` — the fixture
/// only needs to prove the plumbing, not model a real catalogue.
fn body_for(path: &str) -> Option<(&'static str, String)> {
    match path {
        "/api/manga" => Some((
            "application/json",
            r#"{"manga":[{"id":"1","title":"Fixture Manga","cover_url":"/covers/1.jpg"}],"has_next_page":false}"#
                .to_string(),
        )),
        "/api/manga/1" => Some((
            "application/json",
            r#"{"title":"Fixture Manga","author":"Jane Doe","artist":"Jane Doe",
                "description":"A manga that exists only for a test.",
                "tags":["Action","Comedy"],"content_rating":"safe",
                "available_languages":["en"],"cover_url":"/covers/1.jpg"}"#
                .to_string(),
        )),
        "/api/manga/1/volumes" => Some((
            "application/json",
            r#"[{"volume":"1","chapters":[
                {"number":"1","id":"c1","unavailable":false},
                {"number":"2","id":"c2","unavailable":false}
            ]}]"#
                .to_string(),
        )),
        "/api/manga/1/covers" => Some((
            "application/json",
            r#"[{"volume":"1","url":"/covers/v1.jpg","thumbnail_url":"/covers/v1-thumb.jpg"}]"#
                .to_string(),
        )),
        "/read/c1" => Some((
            "text/html; charset=utf-8",
            r#"<!doctype html><html><body>
               <img class="page" src="/pages/c1-01.jpg">
               <img class="page" src="/pages/c1-02.jpg">
               <img class="banner" src="/ads/banner.jpg">
               </body></html>"#
                .to_string(),
        )),
        _ => None,
    }
}

struct Server {
    base: String,
    stop: Arc<AtomicBool>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));

        let flag = stop.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::Relaxed) {
                    return;
                }
                if let Ok(stream) = stream {
                    let _ = handle(stream);
                }
            }
        });

        Self { base, stop }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

fn handle(mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    // Drain the rest of the headers; nothing here needs them.
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
    }

    let Some((content_type, body)) = body_for(&path) else {
        return stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())
}

/// A source script shaped like a real `ParsedHttpSource`: a JSON catalogue,
/// JSON detail/volume/cover endpoints, and one HTML page it CSS-selects.
fn fixture_script(base: &str) -> String {
    format!(
        r#"
        SOURCE = {{ id = "test.fixture", name = "Fixture Site", lang = "en", base_url = "{base}" }}

        local function get_json(path)
            local res = mangalize.http.get(SOURCE.base_url .. path)
            return mangalize.json.decode(res.body)
        end

        function popular(page)
            return get_json("/api/manga?page=" .. page)
        end

        function latest(page)
            return get_json("/api/manga?page=" .. page .. "&sort=latest")
        end

        function search(query, page)
            return get_json("/api/manga?page=" .. page .. "&q=" .. query)
        end

        function manga_details(id)
            return get_json("/api/manga/" .. id)
        end

        function volumes(id, language)
            return get_json("/api/manga/" .. id .. "/volumes")
        end

        function covers(id)
            return get_json("/api/manga/" .. id .. "/covers")
        end

        function page_list(chapter_id)
            local res = mangalize.http.get(SOURCE.base_url .. "/read/" .. chapter_id)
            local rows = mangalize.html.select(res.body, "img.page")
            local urls = {{}}
            for i, row in ipairs(rows) do
                urls[i] = row.attrs.src
            end
            return urls
        end
        "#
    )
}

#[test]
fn a_lua_source_answers_every_call_through_the_real_host_api() {
    let server = Server::start();
    let source = LuaSource::load(fixture_script(&server.base)).unwrap();

    assert_eq!(source.info().id, "test.fixture");
    assert_eq!(source.info().name, "Fixture Site");

    let popular = source.popular(1).unwrap();
    assert_eq!(popular.manga.len(), 1);
    assert_eq!(popular.manga[0].id, "1");
    assert_eq!(popular.manga[0].title, "Fixture Manga");
    assert!(!popular.has_next_page);

    // Not testing that search actually filters — the fixture doesn't bother —
    // only that the same call path (query + page reach the script, JSON comes
    // back parsed) works.
    let searched = source.search("fixture", 1).unwrap();
    assert_eq!(searched.manga.len(), 1);

    let details = source.manga_details("1").unwrap();
    assert_eq!(details.author.as_deref(), Some("Jane Doe"));
    assert_eq!(details.tags, vec!["Action", "Comedy"]);
    assert_eq!(details.available_languages, vec!["en"]);

    let volumes = source.volumes("1", Some("en")).unwrap();
    assert_eq!(volumes.len(), 1);
    assert_eq!(volumes[0].volume, "1");
    assert_eq!(volumes[0].chapters.len(), 2);
    assert_eq!(volumes[0].chapters[0].id.as_deref(), Some("c1"));

    let covers = source.covers("1").unwrap();
    assert_eq!(covers.len(), 1);
    assert_eq!(covers[0].url, "/covers/v1.jpg");

    // Read via CSS selection of a real HTML document, not JSON — the banner
    // is on the page too, and must not be picked up since it doesn't match
    // `img.page`.
    let pages = source.page_list("c1").unwrap();
    assert_eq!(pages, vec!["/pages/c1-01.jpg", "/pages/c1-02.jpg"]);
}

#[test]
fn a_script_cannot_reach_a_host_outside_its_declared_origin() {
    // Two real, independently reachable local servers, not one real one and
    // one non-routable address: a request that failed only because nothing
    // was listening would pass this test whether or not the origin check
    // exists at all. The second server here would happily answer 200 if the
    // script ever actually reached it.
    let own = Server::start();
    let other = Server::start();

    let escaping_script = format!(
        r#"
        SOURCE = {{ id = "test.fixture", name = "Fixture", lang = "en", base_url = "{}" }}
        function manga_details(id)
            local res = mangalize.http.get("{}/api/manga/1")
            return {{ title = res.body }}
        end
        function popular(page) return {{ manga = {{}}, has_next_page = false }} end
        function latest(page) return {{ manga = {{}}, has_next_page = false }} end
        function search(q, page) return {{ manga = {{}}, has_next_page = false }} end
        function volumes(id, lang) return {{}} end
        function covers(id) return {{}} end
        function page_list(id) return {{}} end
        "#,
        own.base, other.base
    );
    let escaping = LuaSource::load(escaping_script).unwrap();
    let result = escaping.manga_details("x");
    assert!(
        result.is_err(),
        "a request to another server, outside the declared origin, must be refused"
    );

    // A well-behaved source calling its own declared origin is unaffected —
    // the restriction is per-request, not a reason to fail everything.
    let source = LuaSource::load(fixture_script(&own.base)).unwrap();
    assert!(source.manga_details("1").is_ok());
}
