package grok

import "testing"

func TestIsGrokImageURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{name: "old generated assets pattern", url: "https://assets.grok.com/users/123/generated/abc123.png?x=1", want: true},
		{name: "new generated assets pattern from app page", url: "https://assets.grok.com/users/e83dc7b8-73de-494b-abde-344184dc4913/generated/1207a261-d83f-4f42-82fc-bc2ad38c63b2/image.jpg?cache=1", want: true},
		{name: "public x.ai image pattern", url: "https://imagine-public.x.ai/imagine-public/images/44c4c863-1115-4095-a4af-ece891c37812.jpg", want: true},
		{name: "new grok generated path", url: "https://grok.com/generated/abc123.webp", want: true},
		{name: "cdn path with query", url: "https://img.grok.com/images/abc123.jpeg?token=abc", want: true},
		{name: "favicon should be ignored", url: "https://grok.com/favicon.ico", want: false},
		{name: "logo should be ignored", url: "https://grok.com/logo.svg", want: false},
		{name: "not grok asset", url: "https://example.com/abc.png", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isGrokImageURL(tt.url); got != tt.want {
				t.Fatalf("isGrokImageURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}
