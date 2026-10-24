import YAML from '@/utils/yaml';

const MIHOMO_TARGETS = new Set(['meta', 'clashmeta', 'clash.meta', 'mihomo']);
const RULE_SOURCES = [
    ['ads', 'domain', 'geosite/category-ads-all.mrs'],
    ['cn-domain', 'domain', 'geosite/cn.mrs'],
    ['non-cn-domain', 'domain', 'geosite/geolocation-!cn.mrs'],
    ['cn-ip', 'ipcidr', 'geoip/cn.mrs'],
];
const SERVICES = [
    ['ai', 'AI 服务', 'category-ai-!cn'],
    ['telegram', 'Telegram', 'telegram'],
    ['youtube', 'YouTube', 'youtube'],
    ['netflix', 'Netflix', 'netflix'],
    ['microsoft', '微软服务', 'microsoft', true],
    ['apple', '苹果服务', 'apple', true],
];
const CHECK_URL = 'https://www.gstatic.com/generate_204';
const DOMESTIC_DNS = [
    'https://223.5.5.5/dns-query#DIRECT',
    'https://doh.pub/dns-query#DIRECT',
];

function createDns(group) {
    return {
        enable: true,
        listen: '127.0.0.1:1053',
        ipv6: false,
        'enhanced-mode': 'redir-host',
        // Explicit DNS transports avoid depending on not-yet-loaded route
        // providers. Node resolution must never require the node itself.
        'respect-rules': false,
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        'proxy-server-nameserver': DOMESTIC_DNS,
        'direct-nameserver': DOMESTIC_DNS,
        'direct-nameserver-follow-policy': false,
        nameserver: [
            `https://1.1.1.1/dns-query#${group}`,
            `https://8.8.8.8/dns-query#${group}`,
        ],
        'nameserver-policy': {
            localhost: 'system',
            '+.lan': 'system',
            '+.local': 'system',
            '+.home.arpa': 'system',
            // Health checks must resolve even when the currently selected node
            // is down, otherwise testing candidate nodes can depend on itself.
            'www.gstatic.com': DOMESTIC_DNS,
            'rule-set:cn-domain': DOMESTIC_DNS,
        },
    };
}

// A subscription download is a client profile by default. Internal producers,
// file composition and explicit provider downloads still use plain node lists.
export function formatMihomoDownload(
    output,
    { platform, profile, produceType } = {},
) {
    if (
        !MIHOMO_TARGETS.has(String(platform).toLowerCase()) ||
        profile === 'nodes' ||
        ['internal', 'raw'].includes(produceType)
    ) {
        return output;
    }

    const proxies = YAML.safeLoad(output)?.proxies;
    if (!Array.isArray(proxies) || proxies.length === 0) {
        throw new Error(
            'Clash Meta 完整配置中没有可用节点，请检查订阅来源和节点兼容性',
        );
    }
    const names = proxies.map((proxy) => proxy.name);
    if (
        names.some((name) => typeof name !== 'string' || !name.trim()) ||
        new Set(names).size !== names.length
    ) {
        throw new Error(
            'Clash Meta 完整配置需要唯一且非空的节点名称，请先重命名重复节点',
        );
    }
    // Groups and nodes share a namespace, including all routing groups.
    const occupied = new Set(names);
    const allocate = (label) => {
        let name = label;
        for (let suffix = 2; occupied.has(name); suffix++)
            name = `${label} (${suffix})`;
        occupied.add(name);
        return name;
    };
    const group = allocate('节点选择');
    const basic = profile === 'basic';
    const automatic = allocate('自动测速');
    const failover = allocate('故障切换');
    const domestic = allocate('国内流量');
    const foreign = allocate('国外流量');
    const ads = allocate('广告拦截');
    const fallback = allocate('漏网之鱼');
    const services = SERVICES.map(([key, label, resource, direct]) => ({
        key,
        name: allocate(label),
        resource,
        direct,
    }));
    const select = (name, choices) => ({
        name,
        type: 'select',
        proxies: choices,
    });
    const providers = Object.fromEntries(
        [
            ...RULE_SOURCES,
            ...services.map(({ key, resource }) => [
                key,
                'domain',
                `geosite/${resource}.mrs`,
            ]),
            ['telegram-ip', 'ipcidr', 'geoip/telegram.mrs'],
        ].map(([name, behavior, resource]) => [
            name,
            {
                type: 'http',
                behavior,
                format: 'mrs',
                interval: 86400,
                url: `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/${resource}`,
                path: `./rule-providers/sub-store-${name}.mrs`,
                // Explicit proxy avoids routing the initial rule download through rules
                // which have not been downloaded yet, and permits access behind blocks.
                proxy: group,
            },
        ]),
    );

    return YAML.safeDump(
        {
            'mixed-port': 7890,
            'allow-lan': false,
            mode: 'rule',
            'log-level': 'info',
            proxies,
            'proxy-groups': [
                select(group, basic ? names : [automatic, failover, ...names]),
                ...(basic
                    ? []
                    : [
                          {
                              name: automatic,
                              type: 'url-test',
                              proxies: names,
                              url: CHECK_URL,
                              interval: 300,
                              tolerance: 50,
                              timeout: 5000,
                              lazy: true,
                              'max-failed-times': 2,
                              'expected-status': '204',
                          },
                          {
                              name: failover,
                              type: 'fallback',
                              proxies: names,
                              url: CHECK_URL,
                              interval: 300,
                              timeout: 5000,
                              lazy: true,
                              'max-failed-times': 2,
                              'expected-status': '204',
                          },
                          select(domestic, ['DIRECT', group]),
                          select(foreign, [group, 'DIRECT']),
                          select(ads, ['REJECT', 'DIRECT']),
                          select(fallback, [group, 'DIRECT']),
                          ...services.map(({ name, direct }) =>
                              select(
                                  name,
                                  direct
                                      ? [
                                            'DIRECT',
                                            group,
                                            automatic,
                                            failover,
                                            ...names,
                                        ]
                                      : [
                                            group,
                                            automatic,
                                            failover,
                                            ...names,
                                            'DIRECT',
                                        ],
                              ),
                          ),
                      ]),
            ],
            ...(basic
                ? {}
                : {
                      'rule-providers': providers,
                      dns: createDns(group),
                      profile: { 'store-selected': true },
                  }),
            rules: [
                'DOMAIN,localhost,DIRECT',
                'DOMAIN-SUFFIX,local,DIRECT',
                'DOMAIN-SUFFIX,lan,DIRECT',
                'DOMAIN-SUFFIX,home.arpa,DIRECT',
                'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
                'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
                'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
                'IP-CIDR6,::1/128,DIRECT,no-resolve',
                'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
                'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
                ...(basic
                    ? []
                    : [
                          `RULE-SET,ads,${ads}`,
                          ...services.map(
                              ({ key, name }) => `RULE-SET,${key},${name}`,
                          ),
                          `RULE-SET,telegram-ip,${
                              services.find((s) => s.key === 'telegram').name
                          },no-resolve`,
                          `RULE-SET,cn-domain,${domestic}`,
                          `RULE-SET,non-cn-domain,${foreign}`,
                          `RULE-SET,cn-ip,${domestic}`,
                      ]),
                `MATCH,${basic ? group : fallback}`,
            ],
        },
        { lineWidth: -1 },
    );
}
