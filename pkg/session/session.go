package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
	"BulkAI/pkg/bulkai"
	"BulkAI/pkg/scrapfly"
	"gopkg.in/yaml.v3"
)

func Run(ctx context.Context, profile bool, output, proxy string) error {
	if output == "" {
		return errors.New("output file is required")
	}
	if fi, err := os.Stat(output); err == nil && fi.IsDir() {
		return fmt.Errorf("output file is a directory: %s", output)
	}

	log.Println("Starting browser")
	defer log.Println("Browser stopped")

	opts := append(
		chromedp.DefaultExecAllocatorOptions[3:],
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.Flag("headless", false),
	)

	if proxy != "" {
		opts = append(opts,
			chromedp.ProxyServer(proxy),
		)
	}

	if profile {
		opts = append(opts,
			// if user-data-dir is set, chrome won't load the default profile,
			// even if it's set to the directory where the default profile is stored.
			// set it to empty to prevent chromedp from setting it to a temp directory.
			chromedp.UserDataDir(""),
			chromedp.Flag("disable-extensions", false),
		)
	}

	ctx, cancel := chromedp.NewExecAllocator(ctx, opts...)
	defer cancel()

	// create chrome instance
	ctx, cancel = chromedp.NewContext(
		ctx,
		// chromedp.WithDebugf(log.Printf),
	)
	defer cancel()

	// disable webdriver
	if err := chromedp.Run(ctx, chromedp.ActionFunc(func(cxt context.Context) error {
		_, err := page.AddScriptToEvaluateOnNewDocument("Object.defineProperty(navigator, 'webdriver', { get: () => false, });").Do(cxt)
		if err != nil {
			return err
		}
		return nil
	})); err != nil {
		return fmt.Errorf("could not disable webdriver: %w", err)
	}

	// check if webdriver is disabled
	/*
		if err := chromedp.Run(ctx,
			chromedp.Navigate("https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html"),
		); err != nil {
			return fmt.Errorf("could not navigate to test page: %w", err)
		}
		<-time.After(1 * time.Second)
	*/

	// obtain ja3
	var ja3 string
	log.Println("Step 1/3: Navigating to JA3 fingerprint page...")
	if err := chromedp.Run(ctx,
		chromedp.Navigate(scrapfly.FPJA3WebURL+"?algo=ja3"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			for i := 0; i < 40; i++ {
				// Dismiss modal if it exists
				_ = chromedp.Run(ctx, chromedp.Evaluate(`
					(function() {
						const closeBtn = document.querySelector('.modal .close, [data-dismiss="modal"], button[aria-label="Close"], .modal-dialog button');
						if (closeBtn) closeBtn.click();
						const maybeLater = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Maybe later'));
						if (maybeLater) maybeLater.click();
					})()
				`, nil))

				var val string
				if err := chromedp.Run(ctx, chromedp.Evaluate(`document.querySelector('#raw_display') ? document.querySelector('#raw_display').innerText : ''`, &val)); err == nil {
					if strings.Contains(val, ",") {
						ja3 = val
						return nil
					}
				}
				log.Printf("Waiting for JA3... (%d/40)\n", i)
				time.Sleep(1 * time.Second)
			}
			return fmt.Errorf("JA3 population timeout")
		}),
	); err != nil {
		return fmt.Errorf("JA3 extraction failed: %w", err)
	}
	log.Println("JA3 obtained successfully.")

	// obtain user agent
	var userAgent, acceptLanguage string
	log.Println("Step 2/3: Navigating to User Agent / HTTP2 page...")
	if err := chromedp.Run(ctx,
		chromedp.Navigate(scrapfly.FPHTTP2WebURL),
		chromedp.ActionFunc(func(ctx context.Context) error {
			for i := 0; i < 40; i++ {
				// Dismiss modal if it exists
				_ = chromedp.Run(ctx, chromedp.Evaluate(`
					(function() {
						const closeBtn = document.querySelector('.modal .close, [data-dismiss="modal"], button[aria-label="Close"], .modal-dialog button');
						if (closeBtn) closeBtn.click();
					})()
				`, nil))

				var body string
				err := chromedp.Run(ctx, chromedp.Evaluate(`
					(function() {
						const headersTabs = document.querySelectorAll('.frame-timeline-item');
						let headersTab = null;
						headersTabs.forEach(t => { if(t.innerText.includes('HEADERS')) headersTab = t; });
						
						if (headersTab && !headersTab.classList.contains('active')) {
							const ev = new MouseEvent('click', {view: window, bubbles: true, cancelable: true});
							headersTab.dispatchEvent(ev);
						}
						
						const preNodes = document.querySelectorAll('pre');
						for (const pre of preNodes) {
							if (pre.innerText.includes('"type": 1') || pre.innerText.includes('user-agent')) {
								return pre.innerText;
							}
						}
						return '';
					})()
				`, &body))
				
				if err == nil && body != "" && strings.Contains(body, "user-agent") {
					var infoHTTP2 scrapfly.InfoHTTP2
					if err := json.Unmarshal([]byte(body), &infoHTTP2); err == nil {
						if v, ok := infoHTTP2.Headers["user-agent"]; ok && len(v) > 0 {
							userAgent = v[0]
						}
						if v, ok := infoHTTP2.Headers["accept-language"]; ok && len(v) > 0 {
							acceptLanguage = strings.Split(v[0], ",")[0]
						}
						if userAgent != "" {
							return nil
						}
					}
				}
				log.Printf("Waiting for HTTP2 data... (%d/40)\n", i)
				time.Sleep(1 * time.Second)
			}
			return errors.New("HTTP2 data population timeout")
		}),
	); err != nil {
		return fmt.Errorf("User Agent extraction failed: %w", err)
	}
	
	log.Println("User-Agent obtained: " + userAgent)
	log.Println("Step 3/3: Navigating to Discord login...")
	if userAgent == "" {
		return errors.New("empty user agent")
	}
	if acceptLanguage == "" {
		return errors.New("empty accept language")
	}

	var lck sync.Mutex

	// Obtain discord token
	var token, cookie, xSuperProperties, xDiscordLocale string
	wait, done := context.WithCancel(context.Background())
	defer done()
	chromedp.ListenTarget(
		ctx,
		func(ev interface{}) {
			if e, ok := ev.(*network.EventRequestWillBeSentExtraInfo); ok {
				if !strings.HasPrefix(getHeader(e, "origin"), "https://discord.com") {
					return
				}

				if h := getHeader(e, "x-discord-locale"); h != "" {
					lck.Lock()
					if xDiscordLocale != h {
						xDiscordLocale = h
						log.Println("locale:", xDiscordLocale)
					}
					lck.Unlock()
				}
				if h := getHeader(e, "x-super-properties"); h != "" {
					lck.Lock()
					if xSuperProperties != h {
						xSuperProperties = h
						log.Println("super-properties:", xSuperProperties)
					}
					lck.Unlock()
				}
				if h := getHeader(e, "cookie"); h != "" {
					lck.Lock()
					if cookie != h {
						cookie = h
						log.Println("cookie:", "...redacted...")
					}
					lck.Unlock()
				}
				if h := getHeader(e, "authorization"); h != "" {
					lck.Lock()
					if token != h {
						token = h
						log.Println("token:", "...redacted...")
					}
					lck.Unlock()
				}

				lck.Lock()
				defer lck.Unlock()
				if token != "" && cookie != "" && xSuperProperties != "" && xDiscordLocale != "" {
					done()
				}
			}
		},
	)

	if err := chromedp.Run(ctx,
		// Load google first to have a sane referer
		chromedp.Navigate("https://www.google.com/"),
		chromedp.WaitReady("body", chromedp.ByQuery),
		chromedp.Navigate("https://discord.com/login"),
	); err != nil {
		return fmt.Errorf("could not obtain discord data: %w", err)
	}

	select {
	case <-wait.Done():
	case <-ctx.Done():
		return ctx.Err()
	}

	userAgent = strings.ReplaceAll(userAgent, "\n", "")
	userAgent = strings.ReplaceAll(userAgent, "like  Gecko", "like Gecko")
	cookie = strings.ReplaceAll(cookie, "\n", "")
	cookie = strings.ReplaceAll(cookie, ";  ", "; ")


	// Fetch Discord user info
	log.Println("Step 3/3: Fetching Discord profile info...")
	req, _ := http.NewRequest("GET", "https://discord.com/api/v9/users/@me", nil)
	req.Header.Set("Authorization", token)
	req.Header.Set("User-Agent", userAgent)
	
	client := &http.Client{}
	resp, err := client.Do(req)
	var username, avatar string
	if err == nil {
		defer resp.Body.Close()
		var profile map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&profile); err == nil {
			if u, ok := profile["username"].(string); ok {
				username = u
				if disc, ok := profile["discriminator"].(string); ok && disc != "0" {
					username = fmt.Sprintf("%s#%s", u, disc)
				}
			}
			var userID string
			if id, ok := profile["id"].(string); ok {
				userID = id
			}
			if a, ok := profile["avatar"].(string); ok {
				if userID != "" {
					avatar = fmt.Sprintf("https://cdn.discordapp.com/avatars/%s/%s.png", userID, a)
				} else {
					avatar = a
				}
			}
		}
	}

	// save session
	session := &bulkai.Session{
		JA3:             ja3,
		UserAgent:       userAgent,
		Token:           token,
		SuperProperties: xSuperProperties,
		Locale:          xDiscordLocale,
		Cookie:          cookie,
		Language:        acceptLanguage,
		Username:        username,
		Avatar:          avatar,
	}
	data, err := yaml.Marshal(session)
	if err != nil {
		return fmt.Errorf("couldn't marshal session: %w", err)
	}
	log.Println("Session successfully obtained")

	// If the file already exists, copy it to a backup file
	if _, err := os.Stat(output); err == nil {
		backup := output
		ext := filepath.Ext(backup)
		// Remove the extension from the output
		backup = strings.TrimSuffix(backup, ext)
		// Add a timestamp to the backup file
		backup = fmt.Sprintf("%s_%s%s", backup, time.Now().Format("20060102150405"), ext)
		if err := os.Rename(output, backup); err != nil {
			return fmt.Errorf("couldn't backup session: %w", err)
		}
		log.Println("Previous session backed up to", backup)
	}

	// Write the session to the output file
	if err := os.WriteFile(output, data, 0644); err != nil {
		return fmt.Errorf("couldn't write session: %w", err)
	}
	log.Println("Session saved to", output)
	return nil
}

func getHeader(e *network.EventRequestWillBeSentExtraInfo, k string) string {
	v := e.Headers[k]
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}
