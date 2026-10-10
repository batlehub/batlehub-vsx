package batlehub.jdt.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** `batlehub.ping` as the client reads it (RFC 0005 §6.3): every rule, and each one's default. */
class HandlerTest {
  @Test
  @SuppressWarnings("unchecked")
  void pingCarriesTheDefaultOfEveryRule() throws Exception {
    Map<String, Object> ping = (Map<String, Object>) new Handler().executeCommand("batlehub.ping", List.of(), null);
    List<String> ids = (List<String>) ping.get("inspections");
    Map<String, String> defaults = (Map<String, String>) ping.get("defaults");
    assertEquals(11, ids.size());
    assertEquals(ids, List.copyOf(defaults.keySet()));
    assertEquals("info", defaults.get("collections/sizeIsZero"));
    assertEquals("warning", defaults.get("unused/privateField"));
    for (String s : defaults.values()) assertEquals(true, List.of("error", "warning", "info", "hint").contains(s), s);
  }
}
