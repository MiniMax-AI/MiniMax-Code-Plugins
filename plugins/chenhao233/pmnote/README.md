# PMNote

PMNote helps game project managers find and use public PMNote articles, podcasts and guides when planning releases, managing delivery risks and collaboration, preparing for interviews, and selecting AI tools.

## Try it

```text
查找 PMNote 关于游戏项目版本排期的文章，整理常见风险并附上来源。
```

The expected result is a grounded answer with links to the relevant public sources, distinguishing sourced claims from advice.

## Requirements

A MiniMax Code-compatible agent, Python 3 and network access are needed for the optional public-content reader. No account, API key or paid service is required by the Skill itself. The public resources are predominantly in Chinese.

## Data and network

The Skill directs the agent to read public resources at https://pmnote.ai and linked public sources such as Xiaoyuzhou, Bilibili and Zhihu. For public interview search, the reader obtains the anonymous public connection from pmnote.ai and sends the search query to the website’s Supabase endpoint. Normal web requests expose the requested URL and network metadata to the destination. It does not require private credentials or include telemetry. External linked works retain their own rights; the MIT license covers this Skill package.
