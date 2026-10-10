package batlehub.jdt.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

/**
 * The pure half of `batlehub.rename` (RFC 0002 §5.3): the symbol grammar.
 * The rename itself needs a Java model over a real workspace, so it is proven
 * by `task jdt:smoke` and the engine half (use case 3), over the real server
 * — as ChainsTest's walk is (RFC 0002 decision 35).
 */
class RenameTest {
  @Test
  void splitsTypeAndMember() {
    assertArrayEquals(new String[] {"com.acme.core.Greeter", "all"}, Rename.parse("com.acme.core.Greeter#all"));
    assertArrayEquals(new String[] {"com.acme.core.Greeter", null}, Rename.parse("com.acme.core.Greeter"));
    assertArrayEquals(new String[] {"Café", "été"}, Rename.parse("Café#été"));
  }

  @Test
  void refusesWhatIsNotASymbol() {
    for (String bad : new String[] {"", "a..b", "a#b#c", "1abc", "a b", "#m", "a.", "Greeter.java:3:5"})
      assertThrows(IllegalArgumentException.class, () -> Rename.parse(bad), bad);
  }
}
