package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.ExpressionMethodReference;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.Modifier;

/** A private method nobody in the file calls or references. */
public final class UnusedPrivateMethod extends Base {
  public UnusedPrivateMethod() {
    super("unused", "privateMethod", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    Set<String> called = new HashSet<>();
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(MethodInvocation n) {
        called.add(n.getName().getIdentifier());
        return true;
      }

      @Override
      public boolean visit(ExpressionMethodReference n) {
        called.add(n.getName().getIdentifier());
        return true;
      }
    });
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(MethodDeclaration m) {
        if (Modifier.isPrivate(m.getModifiers()) && !m.isConstructor() && !called.contains(m.getName().getIdentifier())) {
          String name = m.getName().getIdentifier();
          out.add(new Finding(UnusedPrivateMethod.this, m.getName(), "Private method '" + name + "' is never used", "Remove '" + name + "'", rw -> rw.remove(m, null)));
        }
        return false;
      }
    });
  }
}
