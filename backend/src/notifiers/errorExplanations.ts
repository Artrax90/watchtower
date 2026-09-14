export interface ErrorExplanation {
  title: string;
  category: string;
  description: string;
  recommendation: string;
  shortAlert: string;
}

export function getErrorExplanation(rawErr?: string | null): ErrorExplanation {
  const err = String(rawErr || '').toLowerCase();

  // 1. 504 Gateway Time-out
  if (err.includes('504') || err.includes('gateway time-out') || err.includes('gateway timeout')) {
    return {
      title: 'HTTP 504 Gateway Time-out',
      category: 'Таймаут шлюза / прокси',
      description: 'Промежуточный сервер (Nginx, Traefik, Cloudflare) ждал ответа от основного приложения, но время вышло. Приложение зависло или перегружено.',
      recommendation: 'Проверьте логи бэкенда (Node.js/Python/Go/PHP), загрузку CPU/RAM и медленные SQL-запросы.',
      shortAlert: '⚠️ 504 Gateway Timeout\n\nПричина: бэкенд завис или перегружен.\nЧто делать: проверьте логи службы, CPU/RAM и базу данных.'
    };
  }

  // 2. 502 Bad Gateway
  if (err.includes('502') || err.includes('bad gateway')) {
    return {
      title: 'HTTP 502 Bad Gateway',
      category: 'Ошибочный шлюз',
      description: 'Веб-сервер получил некорректный ответ от внутреннего приложения или процесс упал до передачи ответа.',
      recommendation: 'Проверьте статус службы (systemctl status / docker ps) и не было ли падения по Out-Of-Memory (OOM).',
      shortAlert: '⚠️ 502 Bad Gateway\n\nПричина: служба упала или не отвечает.\nЧто делать: проверьте статус процесса в Docker/systemctl.'
    };
  }

  // 3. 500 Internal Server Error
  if (err.includes('500') || err.includes('internal server error')) {
    return {
      title: 'HTTP 500 Internal Server Error',
      category: 'Внутренняя ошибка сервера',
      description: 'Сервер столкнулся с непредвиденным исключением или ошибкой в коде при обработке HTTP-запроса.',
      recommendation: 'Изучите файл журнала ошибок (error.log), проверьте доступность базы данных и переменные окружения.',
      shortAlert: '⚠️ 500 Internal Error\n\nПричина: ошибка в коде бэкенда.\nЧто делать: изучите журнал error.log и базу данных.'
    };
  }

  // 4. 503 Service Unavailable
  if (err.includes('503') || err.includes('service unavailable')) {
    return {
      title: 'HTTP 503 Service Unavailable',
      category: 'Сервис временно недоступен',
      description: 'Сервер временно не готов обработать запрос из-за перегрузки пула потоков или регламентных работ.',
      recommendation: 'Проверьте нагрузку на сервер и лимиты одновременных воркеров веб-сервера.',
      shortAlert: '⚠️ 503 Service Unavailable\n\nПричина: сервис перегружен или на обслуживании.\nЧто делать: проверьте лимиты соединений.'
    };
  }

  // 5. 403 Forbidden
  if (err.includes('403') || err.includes('forbidden')) {
    return {
      title: 'HTTP 403 Forbidden',
      category: 'Доступ запрещён',
      description: 'Сервер отклонил запрос. Часто это срабатывание защиты от ботов (Cloudflare, WAF) или блокировка по IP.',
      recommendation: 'Проверьте правила файрвола (WAF) и внесите IP мониторинга в список исключений.',
      shortAlert: '⚠️ 403 Forbidden\n\nПричина: блокировка WAF/Cloudflare или IP.\nЧто делать: внесите IP-адрес Watchtower в белый список.'
    };
  }

  // 6. 401 Unauthorized
  if (err.includes('401') || err.includes('unauthorized')) {
    return {
      title: 'HTTP 401 Unauthorized',
      category: 'Требуется авторизация',
      description: 'Для доступа требуются корректные учетные данные (Basic Auth или токен).',
      recommendation: 'Проверьте путь монитора и передачу необходимых заголовков авторизации.',
      shortAlert: '⚠️ 401 Unauthorized\n\nПричина: эндпоинт требует авторизацию.\nЧто делать: укажите публичный health-эндпоинт.'
    };
  }

  // 7. 404 Not Found
  if (err.includes('404') || err.includes('not found')) {
    return {
      title: 'HTTP 404 Not Found',
      category: 'Страница не найдена',
      description: 'Запрашиваемый адрес или эндпоинт отсутствует на целевом сервере.',
      recommendation: 'Проверьте правильность URL цели (Target) в настройках монитора.',
      shortAlert: '⚠️ 404 Not Found\n\nПричина: указанный URL не найден на сервере.\nЧто делать: проверьте точность адреса в мониторе.'
    };
  }

  // 8. TLS Handshake connection timed out
  if (err.includes('handshake') || (err.includes('tls') && err.includes('time'))) {
    return {
      title: 'Таймаут TLS-рукопожатия',
      category: 'Задержка защищённого соединения',
      description: 'Сервер не успел обменяться сертификатами и ключами за лимит времени из-за сетевой задержки или перегрузки CPU. Сам сертификат валиден.',
      recommendation: 'Проверьте сетевой канал до сервера и загрузку процессора на целевом хосте.',
      shortAlert: '⚠️ TLS Handshake Timeout\n\nСертификат в порядке, но рукопожатие не завершилось вовремя из-за задержки сети или CPU.'
    };
  }

  // 9. SSL Expired or invalid
  if (err.includes('ssl') || err.includes('certificate') || err.includes('cert')) {
    return {
      title: 'Ошибка SSL-сертификата',
      category: 'Безопасность HTTPS',
      description: 'Сертификат безопасности просрочен, самоподписан или выпущен для другого домена.',
      recommendation: 'Перевыпустите сертификат (certbot renew) и проверьте привязку доменного имени.',
      shortAlert: '⚠️ Ошибка SSL-сертификата\n\nПричина: сертификат просрочен или недействителен.\nЧто делать: запустите certbot renew.'
    };
  }

  // 10. Request timeout
  if (err.includes('timeout') || err.includes('timed out')) {
    return {
      title: 'Таймаут ожидания ответа',
      category: 'Сетевой таймаут',
      description: 'Сервер не прислал ответ за установленный таймаут. Сервер завис или пакеты теряются по пути.',
      recommendation: 'Убедитесь, что сервер включён и не завис, проверьте память и правила файрвола (iptables/ufw).',
      shortAlert: '⚠️ Превышен таймаут\n\nПричина: сервер не ответил вовремя.\nЧто делать: проверьте доступность хоста и файрвол.'
    };
  }

  // 11. Ping / ICMP failure
  if (err.includes('ping') || err.includes('icmp')) {
    return {
      title: 'Сбой проверки Ping (ICMP)',
      category: 'Сетевая связность',
      description: 'Сервер не ответил на ping. Сервер выключен, перезагружается либо ICMP заблокирован файрволом.',
      recommendation: 'Проверьте питание сервера и разрешение входящих ICMP Echo Request в настройках сети.',
      shortAlert: '⚠️ Сбой Ping (ICMP)\n\nПричина: сервер не отвечает на эхо-запросы.\nЧто делать: проверьте питание и правила ICMP.'
    };
  }

  // 12. Connection refused (ECONNREFUSED)
  if (err.includes('refused') || err.includes('econnrefused')) {
    return {
      title: 'Соединение отклонено (Port Closed)',
      category: 'Сетевой порт закрыт',
      description: 'Хост в сети, но порт закрыт — ни одна программа не слушает подключения на этом порту.',
      recommendation: 'Проверьте, запущена ли служба (Nginx, Docker, PostgreSQL) и слушает ли 0.0.0.0, а не только 127.0.0.1.',
      shortAlert: '⚠️ Порт закрыт (ECONNREFUSED)\n\nПричина: служба не запущена на целевом порту.\nЧто делать: проверьте статус службы и 0.0.0.0.'
    };
  }

  // 13. DNS lookup failed
  if (err.includes('dns') || err.includes('enotfound') || err.includes('getaddrinfo')) {
    return {
      title: 'Ошибка DNS-разрешения',
      category: 'Разрешение доменных имён',
      description: 'Не удалось определить IP-адрес по домену. Либо домен не существует, либо сбоит DNS-сервер.',
      recommendation: 'Проверьте правильность написания домена и настройки DNS A-записи у регистратора.',
      shortAlert: '⚠️ Ошибка DNS (ENOTFOUND)\n\nПричина: домен не найден или сбоит DNS.\nЧто делать: проверьте A-записи домена.'
    };
  }

  // 14. Keyword not found
  if (err.includes('keyword') || err.includes('ключевое слово')) {
    return {
      title: 'Ключевое слово не найдено',
      category: 'Контроль контента',
      description: 'Страница открылась, но на ней нет обязательного текста, заданного в мониторе.',
      recommendation: 'Откройте сайт в браузере и проверьте, отображается ли искомый текст в исходном HTML.',
      shortAlert: '⚠️ Ключевое слово не найдено\n\nПричина: сайт открылся, но текст отсутствует.\nЧто делать: проверьте исходный HTML страницы.'
    };
  }

  // 15. Latency / Degraded
  if (err.includes('задержка') || err.includes('замедление') || err.includes('latency')) {
    return {
      title: 'Высокая задержка отклика',
      category: 'Деградация производительности',
      description: 'Время ответа сервиса существенно превысило норму. Сервер работает медленно под нагрузкой.',
      recommendation: 'Проверьте загрузку дисковой подсистемы (iostat), память и медленные фоновые задачи.',
      shortAlert: '⚠️ Высокая задержка отклика\n\nПричина: сервер отвечает слишком медленно.\nЧто делать: проверьте загрузку CPU/RAM/диска.'
    };
  }

  // Default Fallback
  return {
    title: 'Сбой проверки сервиса',
    category: 'Диагностика',
    description: `Зафиксирована ошибка: ${rawErr || 'Неизвестный сбой'}. Сервис не прошёл проверку параметров доступности.`,
    recommendation: 'Проверьте доступность целевого адреса вручную и изучите системные логи сервера.',
    shortAlert: `⚠️ Сбой проверки\n\nОшибка: ${String(rawErr || 'Недоступен').slice(0, 70)}\nЧто делать: проверьте системные журналы сервера.`
  };
}
