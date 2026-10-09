package batlehub.jdt.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The pure half of the delegate (RFC 0012 §4.2). The walk itself needs a Java
 * project, so it is proven by `task jdt:smoke` (use case 6) and the heavy half
 * (use case 4), over the real server.
 */
class ChainsTest {
  static Chains.Row row(String label, int depth, int locality) {
    return new Chains.Row(label, depth, locality, true);
  }

  @Test
  void localityBeforeDepthBeforeLabel() {
    List<Chains.Row> ranked = Chains.rank(List.of(
        row("Defaults.server().getPort()", 3, 2),
        row("holder.getConfig().getServer().getPort()", 4, 0),
        row("config.getServer().getPort()", 3, 1),
        row("b.getPort()", 2, 0),
        row("a.getPort()", 2, 0)));
    assertEquals(List.of("a.getPort()", "b.getPort()", "holder.getConfig().getServer().getPort()", "config.getServer().getPort()", "Defaults.server().getPort()"),
        ranked.stream().map(Chains.Row::label).toList());
  }

  @Test
  void duplicatesFoldAndTheListIsCut() {
    List<Chains.Row> many = new ArrayList<>();
    for (int i = 0; i < 50; i++) many.add(row("r" + (i % 30) + ".getPort()", 2, 0));
    assertEquals(Chains.MAX_ROWS, Chains.rank(many).size());
  }

  @Test
  void tokenStart() {
    String src = "int port = getS";
    assertEquals(11, Chains.tokenStart(src, src.length()));
    assertEquals(11, Chains.tokenStart("int port = ", 11));
    assertEquals(0, Chains.tokenStart("abc", 99));
  }
}
