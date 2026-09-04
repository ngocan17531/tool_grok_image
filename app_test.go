package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReadAlbumDataCreatesImageOnlyMetadata(t *testing.T) {
	outputDir := t.TempDir()
	albumID := "image-only"
	imagesDir := filepath.Join(outputDir, albumID, "images")
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"b.png", "a.JPG", "_thumbnails.jpg", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(imagesDir, name), []byte("image"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	album, err := readAlbumData(outputDir, albumID)
	if err != nil {
		t.Fatal(err)
	}
	if len(album.Images) != 2 || album.Images[0].File != "a.JPG" || album.Images[1].File != "b.png" {
		t.Fatalf("unexpected image-only album: %#v", album.Images)
	}
	if album.Status != "finished" {
		t.Fatalf("status = %q, want finished", album.Status)
	}

	data, err := os.ReadFile(filepath.Join(outputDir, albumID, "data.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Images []struct {
			File string `json:"file"`
		} `json:"images"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Images) != 2 || saved.Images[0].File != "a.JPG" {
		t.Fatalf("unexpected saved metadata: %#v", saved.Images)
	}
}

func TestCanonicalTitleKey(t *testing.T) {
	cases := map[string]string{
		"Old Town Street":            "old town street",
		"Subject: Old Town Street":   "old town street",
		"subject old town street":    "old town street",
		"[Subject: Old Town Street]": "old town street",
		"  Old   Town   Street  ":    "old town street",
		"old town street.":           "old town street",
	}

	for input, want := range cases {
		if got := canonicalTitleKey(input); got != want {
			t.Fatalf("canonicalTitleKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestFindKeywordsForTitle(t *testing.T) {
	keywordsMap := map[string]string{
		"Old Town Street":          "city, architecture, street",
		"Subject: old town street": "city, architecture, street",
	}

	for _, title := range []string{"Old Town Street", "Subject: Old Town Street", "[Subject: Old Town Street]", "old town street"} {
		if got := findKeywordsForTitle(title, keywordsMap); got == "" {
			t.Fatalf("findKeywordsForTitle(%q) returned empty for map %#v", title, keywordsMap)
		}
	}
}
