export type SourceConfig = {
  id: string;
  name: string;
  url: string;
  pollSeconds: number;
};
export const sources: SourceConfig[] = [
  {
    id: "hackerone",
    name: "HackerOne",
    url: "https://hackerone.com/hacktivity",
    pollSeconds: 14400,
  },
  {
    id: "bugcrowd",
    name: "Bugcrowd public disclosures",
    url: "https://bugcrowd.com/crowdstream",
    pollSeconds: 14400,
  },
  {
    id: "pentester-land",
    name: "Pentester Land",
    url: "https://pentester.land/writeups/",
    pollSeconds: 86400,
  },
  {
    id: "owasp-cheatsheets",
    name: "OWASP Cheat Sheet Series",
    url: "https://cheatsheetseries.owasp.org/",
    pollSeconds: 604800,
  },
  {
    id: "owasp-wstg",
    name: "OWASP Web Security Testing Guide",
    url: "https://owasp.org/www-project-web-security-testing-guide/",
    pollSeconds: 604800,
  },
  {
    id: "arxiv-security",
    name: "arXiv web security research",
    url: "https://arxiv.org/list/cs.CR/recent",
    pollSeconds: 86400,
  },
  {
    id: "yeswehack-research",
    name: "YesWeHack Research",
    url: "https://www.yeswehack.com/blog/learn-bug-bounty",
    pollSeconds: 14400,
  },
];
