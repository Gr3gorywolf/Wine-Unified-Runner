export interface GithubAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface GithubRelease {
  tag_name: string
  published_at: string
  html_url: string
  assets: GithubAsset[]
}

export interface LutrisRuntime {
  name: string
  url: string
  created_at?: string
}
